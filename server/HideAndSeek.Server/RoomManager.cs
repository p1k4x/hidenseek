using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace HideAndSeek.Server;

public sealed class RoomManager
{
    public const int HideSeconds = 12;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly ConcurrentDictionary<string, Room> _rooms = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<WebSocket, string> _socketRooms = new();

    public async Task HandleSocketAsync(WebSocket socket, CancellationToken ct)
    {
        var buffer = new byte[4 * 1024];

        try
        {
            while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                var result = await socket.ReceiveAsync(buffer, ct);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    break;
                }

                if (result.MessageType != WebSocketMessageType.Text)
                {
                    continue;
                }

                var json = Encoding.UTF8.GetString(buffer, 0, result.Count);
                ClientMessage? message;
                try
                {
                    message = JsonSerializer.Deserialize<ClientMessage>(json, JsonOptions);
                }
                catch (JsonException)
                {
                    await SendAsync(socket, ServerMessages.Error("Invalid JSON."), ct);
                    continue;
                }

                if (message is null || string.IsNullOrWhiteSpace(message.Type))
                {
                    await SendAsync(socket, ServerMessages.Error("Missing message type."), ct);
                    continue;
                }

                switch (message.Type)
                {
                    case "create":
                        await CreateAsync(socket, message.Role, ct);
                        break;
                    case "join":
                        await JoinAsync(socket, message.Code, ct);
                        break;
                    case "start":
                        await StartAsync(socket, ct);
                        break;
                    case "leave":
                        await LeaveAsync(socket, ct);
                        break;
                    default:
                        await SendAsync(socket, ServerMessages.Error($"Unknown type: {message.Type}"), ct);
                        break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Shutting down.
        }
        catch (WebSocketException)
        {
            // Client gone.
        }
        finally
        {
            await LeaveAsync(socket, CancellationToken.None);
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                try
                {
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None);
                }
                catch
                {
                    // Ignore close failures.
                }
            }
        }
    }

    private async Task CreateAsync(WebSocket socket, string? role, CancellationToken ct)
    {
        if (!Roles.IsValid(role))
        {
            await SendAsync(socket, ServerMessages.Error("Choose hider or seeker."), ct);
            return;
        }

        await LeaveAsync(socket, ct);

        var code = NewCode();
        var room = new Room(code, socket, role!);
        if (!_rooms.TryAdd(code, room))
        {
            await SendAsync(socket, ServerMessages.Error("Could not create room."), ct);
            return;
        }

        _socketRooms[socket] = code;
        await SendAsync(socket, ServerMessages.Room(code, role!, isHost: true, guestConnected: false), ct);
    }

    private async Task JoinAsync(WebSocket socket, string? code, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(code))
        {
            await SendAsync(socket, ServerMessages.Error("Enter a room code."), ct);
            return;
        }

        code = code.Trim().ToUpperInvariant();
        if (!_rooms.TryGetValue(code, out var room))
        {
            await SendAsync(socket, ServerMessages.Error("Room not found."), ct);
            return;
        }

        await LeaveAsync(socket, ct);

        string? error = null;
        string guestRole = "";
        WebSocket? hostSocket = null;
        lock (room.Gate)
        {
            if (room.Guest is not null)
            {
                error = "Room is full.";
            }
            else if (room.Started)
            {
                error = "Match already started.";
            }
            else
            {
                guestRole = Roles.Opposite(room.HostRole);
                room.Guest = socket;
                room.GuestRole = guestRole;
                hostSocket = room.Host;
                _socketRooms[socket] = code;
            }
        }

        if (error is not null)
        {
            await SendAsync(socket, ServerMessages.Error(error), ct);
            return;
        }

        await SendAsync(socket, ServerMessages.Room(code, guestRole, isHost: false, guestConnected: true), ct);
        if (hostSocket is not null && hostSocket.State == WebSocketState.Open)
        {
            await SendAsync(
                hostSocket,
                ServerMessages.Room(code, room.HostRole, isHost: true, guestConnected: true),
                ct);
        }
    }

    private async Task StartAsync(WebSocket socket, CancellationToken ct)
    {
        if (!_socketRooms.TryGetValue(socket, out var code) || !_rooms.TryGetValue(code, out var room))
        {
            await SendAsync(socket, ServerMessages.Error("Not in a room."), ct);
            return;
        }

        string? error = null;
        WebSocket? host = null;
        WebSocket? guest = null;
        lock (room.Gate)
        {
            if (!ReferenceEquals(room.Host, socket))
            {
                error = "Only the host can start.";
            }
            else if (room.Guest is null)
            {
                error = "Waiting for an opponent.";
            }
            else if (room.Started)
            {
                error = "Match already started.";
            }
            else
            {
                room.Started = true;
                host = room.Host;
                guest = room.Guest;
            }
        }

        if (error is not null || host is null)
        {
            await SendAsync(socket, ServerMessages.Error(error ?? "Could not start."), ct);
            return;
        }

        var hideEndsAt = DateTimeOffset.UtcNow.AddSeconds(HideSeconds).ToUnixTimeMilliseconds();
        var payload = ServerMessages.MatchStart(hideEndsAt);
        await SendAsync(host, payload, ct);
        if (guest is not null)
        {
            await SendAsync(guest, payload, ct);
        }
    }

    private async Task LeaveAsync(WebSocket socket, CancellationToken ct)
    {
        if (!_socketRooms.TryRemove(socket, out var code))
        {
            return;
        }

        if (!_rooms.TryGetValue(code, out var room))
        {
            return;
        }

        WebSocket? notify = null;
        var removeRoom = false;

        lock (room.Gate)
        {
            if (ReferenceEquals(room.Host, socket))
            {
                notify = room.Guest;
                removeRoom = true;
                room.Host = null!;
                room.Guest = null;
            }
            else if (ReferenceEquals(room.Guest, socket))
            {
                notify = room.Host;
                room.Guest = null;
                room.GuestRole = null;
                if (room.Started)
                {
                    removeRoom = true;
                }
            }
            else
            {
                return;
            }
        }

        if (removeRoom)
        {
            _rooms.TryRemove(code, out _);
            if (notify is not null)
            {
                _socketRooms.TryRemove(notify, out _);
            }
        }

        if (notify is not null && notify.State == WebSocketState.Open)
        {
            await SendAsync(notify, ServerMessages.PeerLeft(), ct);
            if (!removeRoom && _rooms.TryGetValue(code, out var stillThere))
            {
                await SendAsync(
                    notify,
                    ServerMessages.Room(code, stillThere.HostRole, isHost: true, guestConnected: false),
                    ct);
            }
        }
    }

    private static string NewCode()
    {
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        Span<char> chars = stackalloc char[4];
        for (var i = 0; i < chars.Length; i++)
        {
            chars[i] = alphabet[Random.Shared.Next(alphabet.Length)];
        }

        return new string(chars);
    }

    private static async Task SendAsync(WebSocket socket, object payload, CancellationToken ct)
    {
        if (socket.State != WebSocketState.Open)
        {
            return;
        }

        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload, JsonOptions));
        await socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct);
    }

    private sealed class Room
    {
        public Room(string code, WebSocket host, string hostRole)
        {
            Code = code;
            Host = host;
            HostRole = hostRole;
        }

        public string Code { get; }
        public object Gate { get; } = new();
        public WebSocket Host { get; set; }
        public string HostRole { get; }
        public WebSocket? Guest { get; set; }
        public string? GuestRole { get; set; }
        public bool Started { get; set; }
    }
}
