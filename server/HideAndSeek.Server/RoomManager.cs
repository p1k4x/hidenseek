using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace HideAndSeek.Server;

public sealed class RoomManager
{
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
                    case "pose":
                        await PoseAsync(socket, message, ct);
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

            RemoveSendGate(socket);
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
        long hideEndsAt = 0;
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
                room.MatchPhase = MatchPhase.Hiding;
                room.HiderPose = Pose.Empty;
                room.SeekerPose = Pose.Empty;
                room.Spotted = false;
                hideEndsAt = DateTimeOffset.UtcNow.AddSeconds(MatchRules.HideSeconds).ToUnixTimeMilliseconds();
                room.PhaseEndsAt = hideEndsAt;
                room.SeekEndsAt = hideEndsAt + MatchRules.SeekSeconds * 1000L;
                host = room.Host;
                guest = room.Guest;
                room.MatchCts?.Cancel();
                room.MatchCts = new CancellationTokenSource();
                _ = RunMatchLoopAsync(room, room.MatchCts.Token);
            }
        }

        if (error is not null || host is null)
        {
            await SendAsync(socket, ServerMessages.Error(error ?? "Could not start."), ct);
            return;
        }

        var payload = ServerMessages.MatchStart(hideEndsAt);
        await SendAsync(host, payload, ct);
        if (guest is not null)
        {
            await SendAsync(guest, payload, ct);
        }
    }

    private async Task PoseAsync(WebSocket socket, ClientMessage message, CancellationToken ct)
    {
        if (!_socketRooms.TryGetValue(socket, out var code) || !_rooms.TryGetValue(code, out var room))
        {
            return;
        }

        if (message.X is null || message.Y is null || message.Z is null || message.Yaw is null)
        {
            return;
        }

        var pose = Pose.From(message.X.Value, message.Y.Value, message.Z.Value, message.Yaw.Value);
        string? role = null;
        WebSocket? peer = null;
        var shouldRelay = false;

        lock (room.Gate)
        {
            if (!room.Started || room.MatchPhase is not (MatchPhase.Hiding or MatchPhase.Seeking))
            {
                return;
            }

            if (ReferenceEquals(room.Host, socket))
            {
                role = room.HostRole;
                peer = room.Guest;
            }
            else if (ReferenceEquals(room.Guest, socket))
            {
                role = room.GuestRole;
                peer = room.Host;
            }
            else
            {
                return;
            }

            if (role == Roles.Hider)
            {
                room.HiderPose = pose;
            }
            else
            {
                room.SeekerPose = pose;
            }

            // Always relay seeker→hider; only reveal hider once seeking.
            shouldRelay = role == Roles.Seeker || room.MatchPhase == MatchPhase.Seeking;
        }

        if (role is null || peer is null)
        {
            return;
        }

        if (shouldRelay)
        {
            await SendAsync(
                peer,
                ServerMessages.Pose(role, pose.X, pose.Y, pose.Z, pose.Yaw),
                ct);
        }

        await EvaluateMatchAsync(room, ct);
    }

    private async Task RunMatchLoopAsync(Room room, CancellationToken ct)
    {
        var delay = TimeSpan.FromMilliseconds(1000.0 / MatchRules.PoseHz);
        try
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(delay, ct);
                await EvaluateMatchAsync(room, ct);
            }
        }
        catch (OperationCanceledException)
        {
            // Match ended or room torn down.
        }
    }

    private async Task EvaluateMatchAsync(Room room, CancellationToken ct)
    {
        WebSocket? host;
        WebSocket? guest;
        MatchPhase phase;
        long phaseEndsAt;
        long seekEndsAt;
        Pose hider;
        Pose seeker;
        var wasSpotted = false;

        lock (room.Gate)
        {
            if (!room.Started || room.MatchPhase is MatchPhase.Ended or MatchPhase.Lobby)
            {
                return;
            }

            host = room.Host;
            guest = room.Guest;
            phase = room.MatchPhase;
            phaseEndsAt = room.PhaseEndsAt;
            seekEndsAt = room.SeekEndsAt;
            hider = room.HiderPose;
            seeker = room.SeekerPose;
            wasSpotted = room.Spotted;
        }

        if (host is null || guest is null)
        {
            return;
        }

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        if (phase == MatchPhase.Hiding && now >= phaseEndsAt)
        {
            lock (room.Gate)
            {
                if (room.MatchPhase != MatchPhase.Hiding)
                {
                    return;
                }

                room.MatchPhase = MatchPhase.Seeking;
                room.PhaseEndsAt = seekEndsAt;
                phase = MatchPhase.Seeking;
                phaseEndsAt = seekEndsAt;
            }

            var seeking = ServerMessages.Phase("seeking", phaseEndsAt);
            await SendAsync(host, seeking, ct);
            await SendAsync(guest, seeking, ct);
        }

        if (phase == MatchPhase.Seeking)
        {
            if (hider.IsSet && seeker.IsSet)
            {
                var caught = MatchRules.TryCatch(seeker, hider, out var spotted);
                if (spotted != wasSpotted)
                {
                    lock (room.Gate)
                    {
                        room.Spotted = spotted;
                    }

                    var spottedMsg = ServerMessages.Spotted(spotted);
                    await SendAsync(host, spottedMsg, ct);
                    await SendAsync(guest, spottedMsg, ct);
                }

                if (caught)
                {
                    await EndMatchAsync(room, "caught", ct);
                    return;
                }
            }

            if (now >= seekEndsAt)
            {
                await EndMatchAsync(room, "escaped", ct);
            }
        }
    }

    private async Task EndMatchAsync(Room room, string outcome, CancellationToken ct)
    {
        WebSocket? host;
        WebSocket? guest;
        lock (room.Gate)
        {
            if (room.MatchPhase == MatchPhase.Ended)
            {
                return;
            }

            room.MatchPhase = MatchPhase.Ended;
            room.Started = false;
            host = room.Host;
            guest = room.Guest;
            try
            {
                room.MatchCts?.Cancel();
            }
            catch
            {
                // Ignore.
            }
        }

        var payload = ServerMessages.MatchEnd(outcome);
        if (host is not null)
        {
            await SendAsync(host, payload, ct);
        }

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
                room.MatchPhase = MatchPhase.Ended;
                try
                {
                    room.MatchCts?.Cancel();
                }
                catch
                {
                    // Ignore.
                }
            }
            else if (ReferenceEquals(room.Guest, socket))
            {
                notify = room.Host;
                room.Guest = null;
                room.GuestRole = null;
                if (room.Started || room.MatchPhase is MatchPhase.Hiding or MatchPhase.Seeking)
                {
                    removeRoom = true;
                    room.MatchPhase = MatchPhase.Ended;
                    try
                    {
                        room.MatchCts?.Cancel();
                    }
                    catch
                    {
                        // Ignore.
                    }
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
        // Serialize sends per-socket; concurrent SendAsync is not safe.
        var gate = SocketSendGates.GetOrAdd(socket, _ => new SemaphoreSlim(1, 1));
        try
        {
            await gate.WaitAsync(ct);
        }
        catch (ObjectDisposedException)
        {
            return;
        }

        try
        {
            if (socket.State != WebSocketState.Open)
            {
                return;
            }

            await socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct);
        }
        finally
        {
            try
            {
                gate.Release();
            }
            catch (ObjectDisposedException)
            {
                // Gate already cleaned up on disconnect.
            }
        }
    }

    private static void RemoveSendGate(WebSocket socket)
    {
        if (SocketSendGates.TryRemove(socket, out var gate))
        {
            gate.Dispose();
        }
    }

    private static readonly ConcurrentDictionary<WebSocket, SemaphoreSlim> SocketSendGates = new();

    private enum MatchPhase
    {
        Lobby,
        Hiding,
        Seeking,
        Ended,
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
        public MatchPhase MatchPhase { get; set; } = MatchPhase.Lobby;
        public long PhaseEndsAt { get; set; }
        public long SeekEndsAt { get; set; }
        public Pose HiderPose { get; set; }
        public Pose SeekerPose { get; set; }
        public bool Spotted { get; set; }
        public CancellationTokenSource? MatchCts { get; set; }
    }
}
