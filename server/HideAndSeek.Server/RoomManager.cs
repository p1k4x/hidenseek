using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace HideAndSeek.Server;

public sealed class RoomManager
{
    private const int ReconnectGraceSeconds = 45;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly ConcurrentDictionary<string, Room> _rooms = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<WebSocket, string> _socketRooms = new();
    private readonly ConcurrentDictionary<string, string> _sessions = new(StringComparer.Ordinal);

    public async Task HandleSocketAsync(WebSocket socket, CancellationToken ct)
    {
        var buffer = new byte[4 * 1024];
        var intentionalLeave = false;

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
                    case "reconnect":
                        await ReconnectAsync(socket, message.SessionId, ct);
                        break;
                    case "start":
                        await StartAsync(socket, ct);
                        break;
                    case "pose":
                        await PoseAsync(socket, message, ct);
                        break;
                    case "leave":
                        intentionalLeave = true;
                        await LeaveAsync(socket, intentional: true, ct);
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
            if (!intentionalLeave)
            {
                await LeaveAsync(socket, intentional: false, CancellationToken.None);
            }

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

        await LeaveAsync(socket, intentional: true, ct);

        var code = NewCode();
        var sessionId = NewSessionId();
        var room = new Room(code, socket, role!, sessionId);
        if (!_rooms.TryAdd(code, room))
        {
            await SendAsync(socket, ServerMessages.Error("Could not create room."), ct);
            return;
        }

        _socketRooms[socket] = code;
        _sessions[sessionId] = code;
        await SendAsync(socket, ServerMessages.Room(code, role!, isHost: true, guestConnected: false, sessionId), ct);
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

        await LeaveAsync(socket, intentional: true, ct);

        string? error = null;
        string guestRole = "";
        string sessionId = "";
        WebSocket? hostSocket = null;
        lock (room.Gate)
        {
            var guestSeatTaken = room.Guest is not null || room.GuestSessionId is not null;
            if (guestSeatTaken)
            {
                error = "Room is full.";
            }
            else if (room.Started)
            {
                error = "Match already started.";
            }
            else if (room.Host is null)
            {
                error = "Host is reconnecting. Try again shortly.";
            }
            else
            {
                guestRole = Roles.Opposite(room.HostRole);
                sessionId = NewSessionId();
                room.Guest = socket;
                room.GuestRole = guestRole;
                room.GuestSessionId = sessionId;
                hostSocket = room.Host;
                _socketRooms[socket] = code;
                _sessions[sessionId] = code;
            }
        }

        if (error is not null)
        {
            await SendAsync(socket, ServerMessages.Error(error), ct);
            return;
        }

        await SendAsync(socket, ServerMessages.Room(code, guestRole, isHost: false, guestConnected: true, sessionId), ct);
        if (hostSocket is not null && hostSocket.State == WebSocketState.Open)
        {
            await SendAsync(
                hostSocket,
                ServerMessages.Room(code, room.HostRole, isHost: true, guestConnected: true, room.HostSessionId),
                ct);
        }
    }

    private async Task ReconnectAsync(WebSocket socket, string? sessionId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            await SendAsync(socket, ServerMessages.Error("Missing session."), ct);
            return;
        }

        if (!_sessions.TryGetValue(sessionId, out var code) || !_rooms.TryGetValue(code, out var room))
        {
            await SendAsync(socket, ServerMessages.Error("Session expired. Create or join a new room."), ct);
            return;
        }

        // Drop any other seat this socket might hold.
        await LeaveAsync(socket, intentional: true, ct);

        string? error = null;
        var isHost = false;
        string role = "";
        MatchPhase phase = MatchPhase.Lobby;
        long endsAt = 0;
        var spotted = false;
        var guestConnected = false;
        WebSocket? peer = null;
        Pose? peerPose = null;
        string? peerNotifyRole = null;
        string? peerNotifySessionId = null;

        lock (room.Gate)
        {
            if (sessionId == room.HostSessionId)
            {
                if (room.Host is not null && room.Host.State == WebSocketState.Open)
                {
                    error = "Already connected from another tab.";
                }
                else
                {
                    CancelGrace(room, isHost: true);
                    room.Host = socket;
                    isHost = true;
                    role = room.HostRole;
                    peer = room.Guest;
                    peerNotifyRole = room.GuestRole;
                    peerNotifySessionId = room.GuestSessionId;
                    _socketRooms[socket] = code;
                }
            }
            else if (sessionId == room.GuestSessionId)
            {
                if (room.Guest is not null && room.Guest.State == WebSocketState.Open)
                {
                    error = "Already connected from another tab.";
                }
                else
                {
                    CancelGrace(room, isHost: false);
                    room.Guest = socket;
                    isHost = false;
                    role = room.GuestRole ?? Roles.Opposite(room.HostRole);
                    peer = room.Host;
                    peerNotifyRole = room.HostRole;
                    peerNotifySessionId = room.HostSessionId;
                    _socketRooms[socket] = code;
                }
            }
            else
            {
                error = "Session expired. Create or join a new room.";
            }

            if (error is null)
            {
                phase = room.MatchPhase;
                endsAt = room.PhaseEndsAt;
                spotted = room.Spotted;
                guestConnected = room.Guest is not null || room.GuestSessionId is not null;
                if (phase is MatchPhase.Hiding or MatchPhase.Seeking)
                {
                    var mineIsHider = role == Roles.Hider;
                    var theirs = mineIsHider ? room.SeekerPose : room.HiderPose;
                    if (theirs.IsSet)
                    {
                        peerPose = theirs;
                    }
                }
            }
        }

        if (error is not null)
        {
            await SendAsync(socket, ServerMessages.Error(error), ct);
            return;
        }

        await SendAsync(socket, ServerMessages.Room(code, role, isHost, guestConnected, sessionId), ct);

        if (phase is MatchPhase.Hiding or MatchPhase.Seeking)
        {
            var phaseName = phase == MatchPhase.Hiding ? "hiding" : "seeking";
            await SendAsync(socket, ServerMessages.MatchResume(phaseName, endsAt, spotted), ct);
            // No peer poses during hide — neither side should see the other until seeking.
            if (peerPose is { } pose && phase == MatchPhase.Seeking)
            {
                var peerRole = role == Roles.Hider ? Roles.Seeker : Roles.Hider;
                await SendAsync(socket, ServerMessages.Pose(peerRole, pose.X, pose.Y, pose.Z, pose.Yaw, pose.Crouch), ct);
            }
        }

        if (peer is not null && peer.State == WebSocketState.Open && peerNotifyRole is not null && peerNotifySessionId is not null)
        {
            await SendAsync(peer, ServerMessages.PeerResumed(), ct);
            await SendAsync(
                peer,
                ServerMessages.Room(code, peerNotifyRole, isHost: !isHost, guestConnected: true, peerNotifySessionId),
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

        var pose = Pose.From(
            message.X.Value,
            message.Y.Value,
            message.Z.Value,
            message.Yaw.Value,
            message.Crouch ?? false);
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

            // Reveal neither side until seeking starts.
            shouldRelay = room.MatchPhase == MatchPhase.Seeking;
        }

        if (role is null)
        {
            return;
        }

        if (shouldRelay && peer is not null)
        {
            await SendAsync(
                peer,
                ServerMessages.Pose(role, pose.X, pose.Y, pose.Z, pose.Yaw, pose.Crouch),
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
            await SendToSeatAsync(host, seeking, ct);
            await SendToSeatAsync(guest, seeking, ct);
        }

        if (phase == MatchPhase.Seeking)
        {
            // Skip catch/spotted while a seat is vacant (reconnect grace) — poses go stale.
            // Phase clock and escape timeout still run.
            if (host is not null && guest is not null && hider.IsSet && seeker.IsSet)
            {
                var caught = MatchRules.TryCatch(seeker, hider, out var spotted);
                if (spotted != wasSpotted)
                {
                    lock (room.Gate)
                    {
                        room.Spotted = spotted;
                    }

                    var spottedMsg = ServerMessages.Spotted(spotted);
                    await SendToSeatAsync(host, spottedMsg, ct);
                    await SendToSeatAsync(guest, spottedMsg, ct);
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
        await SendToSeatAsync(host, payload, ct);
        await SendToSeatAsync(guest, payload, ct);
    }

    private async Task LeaveAsync(WebSocket socket, bool intentional, CancellationToken ct)
    {
        if (!_socketRooms.TryRemove(socket, out var code))
        {
            return;
        }

        if (!_rooms.TryGetValue(code, out var room))
        {
            return;
        }

        if (!intentional)
        {
            await SoftDisconnectAsync(socket, room, code, ct);
            return;
        }

        await HardDisconnectAsync(socket, room, code, ct);
    }

    private async Task SoftDisconnectAsync(WebSocket socket, Room room, string code, CancellationToken ct)
    {
        WebSocket? notify = null;
        var startedGrace = false;

        lock (room.Gate)
        {
            if (ReferenceEquals(room.Host, socket))
            {
                room.Host = null;
                notify = room.Guest;
                CancelGrace(room, isHost: true);
                room.HostGraceCts = new CancellationTokenSource();
                startedGrace = true;
                _ = ExpireGraceAsync(room, code, isHost: true, room.HostGraceCts.Token);
            }
            else if (ReferenceEquals(room.Guest, socket))
            {
                room.Guest = null;
                notify = room.Host;
                CancelGrace(room, isHost: false);
                room.GuestGraceCts = new CancellationTokenSource();
                startedGrace = true;
                _ = ExpireGraceAsync(room, code, isHost: false, room.GuestGraceCts.Token);
            }
        }

        if (!startedGrace)
        {
            return;
        }

        if (notify is not null && notify.State == WebSocketState.Open)
        {
            await SendAsync(notify, ServerMessages.PeerReconnecting(), ct);
        }
    }

    private async Task ExpireGraceAsync(Room room, string code, bool isHost, CancellationToken ct)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(ReconnectGraceSeconds), ct);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        if (!_rooms.TryGetValue(code, out var still) || !ReferenceEquals(still, room))
        {
            return;
        }

        lock (room.Gate)
        {
            if (isHost)
            {
                if (room.Host is not null)
                {
                    return;
                }
            }
            else if (room.Guest is not null)
            {
                return;
            }
        }

        await HardLeaveSeatAsync(room, code, isHost, CancellationToken.None);
    }

    private async Task HardDisconnectAsync(WebSocket socket, Room room, string code, CancellationToken ct)
    {
        WebSocket? notify = null;
        var removeRoom = false;
        string? clearSession = null;
        string? clearPeerSession = null;

        lock (room.Gate)
        {
            if (ReferenceEquals(room.Host, socket))
            {
                notify = room.Guest;
                removeRoom = true;
                clearSession = room.HostSessionId;
                clearPeerSession = room.GuestSessionId;
                CancelGrace(room, isHost: true);
                CancelGrace(room, isHost: false);
                room.Host = null;
                room.Guest = null;
                room.GuestSessionId = null;
                room.GuestRole = null;
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
                clearSession = room.GuestSessionId;
                CancelGrace(room, isHost: false);
                room.Guest = null;
                room.GuestSessionId = null;
                room.GuestRole = null;
                if (room.Started || room.MatchPhase is MatchPhase.Hiding or MatchPhase.Seeking)
                {
                    removeRoom = true;
                    clearPeerSession = room.HostSessionId;
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

        await FinishHardLeaveAsync(code, notify, removeRoom, clearSession, clearPeerSession, ct);
    }

    /// <summary>Grace timer expired with seat still vacant.</summary>
    private async Task HardLeaveSeatAsync(Room room, string code, bool isHost, CancellationToken ct)
    {
        WebSocket? notify = null;
        var removeRoom = false;
        string? clearSession = null;
        string? clearPeerSession = null;

        lock (room.Gate)
        {
            if (isHost)
            {
                if (room.Host is not null)
                {
                    return;
                }

                notify = room.Guest;
                removeRoom = true;
                clearSession = room.HostSessionId;
                clearPeerSession = room.GuestSessionId;
                CancelGrace(room, isHost: true);
                CancelGrace(room, isHost: false);
                room.Guest = null;
                room.GuestSessionId = null;
                room.GuestRole = null;
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
            else
            {
                if (room.Guest is not null)
                {
                    return;
                }

                notify = room.Host;
                clearSession = room.GuestSessionId;
                CancelGrace(room, isHost: false);
                room.GuestSessionId = null;
                room.GuestRole = null;
                if (room.Started || room.MatchPhase is MatchPhase.Hiding or MatchPhase.Seeking)
                {
                    removeRoom = true;
                    clearPeerSession = room.HostSessionId;
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
        }

        await FinishHardLeaveAsync(code, notify, removeRoom, clearSession, clearPeerSession, ct);
    }

    private async Task FinishHardLeaveAsync(
        string code,
        WebSocket? notify,
        bool removeRoom,
        string? clearSession,
        string? clearPeerSession,
        CancellationToken ct)
    {
        if (clearSession is not null)
        {
            _sessions.TryRemove(clearSession, out _);
        }

        if (removeRoom)
        {
            _rooms.TryRemove(code, out _);
            if (clearPeerSession is not null)
            {
                _sessions.TryRemove(clearPeerSession, out _);
            }

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
                    ServerMessages.Room(code, stillThere.HostRole, isHost: true, guestConnected: false, stillThere.HostSessionId),
                    ct);
            }
        }
    }

    private static void CancelGrace(Room room, bool isHost)
    {
        try
        {
            if (isHost)
            {
                room.HostGraceCts?.Cancel();
                room.HostGraceCts = null;
            }
            else
            {
                room.GuestGraceCts?.Cancel();
                room.GuestGraceCts = null;
            }
        }
        catch
        {
            // Ignore.
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

    private static string NewSessionId() => Guid.NewGuid().ToString("N");

    private static async Task SendToSeatAsync(WebSocket? socket, object payload, CancellationToken ct)
    {
        if (socket is null)
        {
            return;
        }

        await SendAsync(socket, payload, ct);
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
        public Room(string code, WebSocket host, string hostRole, string hostSessionId)
        {
            Code = code;
            Host = host;
            HostRole = hostRole;
            HostSessionId = hostSessionId;
        }

        public string Code { get; }
        public object Gate { get; } = new();
        public WebSocket? Host { get; set; }
        public string HostRole { get; }
        public string HostSessionId { get; }
        public WebSocket? Guest { get; set; }
        public string? GuestRole { get; set; }
        public string? GuestSessionId { get; set; }
        public bool Started { get; set; }
        public MatchPhase MatchPhase { get; set; } = MatchPhase.Lobby;
        public long PhaseEndsAt { get; set; }
        public long SeekEndsAt { get; set; }
        public Pose HiderPose { get; set; }
        public Pose SeekerPose { get; set; }
        public bool Spotted { get; set; }
        public CancellationTokenSource? MatchCts { get; set; }
        public CancellationTokenSource? HostGraceCts { get; set; }
        public CancellationTokenSource? GuestGraceCts { get; set; }
    }
}
