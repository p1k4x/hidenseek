using System.Text.Json.Serialization;

namespace HideAndSeek.Server;

public static class Roles
{
    public const string Hider = "hider";
    public const string Seeker = "seeker";

    public static string Opposite(string role) =>
        role == Hider ? Seeker : Hider;

    public static bool IsValid(string? role) =>
        role is Hider or Seeker;
}

public sealed class ClientMessage
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "";

    [JsonPropertyName("role")]
    public string? Role { get; set; }

    [JsonPropertyName("code")]
    public string? Code { get; set; }

    [JsonPropertyName("sessionId")]
    public string? SessionId { get; set; }

    [JsonPropertyName("x")]
    public double? X { get; set; }

    [JsonPropertyName("y")]
    public double? Y { get; set; }

    [JsonPropertyName("z")]
    public double? Z { get; set; }

    [JsonPropertyName("yaw")]
    public double? Yaw { get; set; }

    [JsonPropertyName("crouch")]
    public bool? Crouch { get; set; }
}

public static class ServerMessages
{
    public static object Room(string code, string role, bool isHost, bool guestConnected, string sessionId) => new
    {
        type = "room",
        code,
        role,
        isHost,
        guestConnected,
        sessionId,
    };

    public static object Error(string message) => new
    {
        type = "error",
        message,
    };

    public static object MatchStart(long hideEndsAt) => new
    {
        type = "matchStart",
        hideEndsAt,
    };

    public static object Phase(string phase, long endsAt) => new
    {
        type = "phase",
        phase,
        endsAt,
    };

    public static object Pose(string role, double x, double y, double z, double yaw, bool crouch) => new
    {
        type = "pose",
        role,
        x,
        y,
        z,
        yaw,
        crouch,
    };

    public static object Spotted(bool active) => new
    {
        type = "spotted",
        active,
    };

    public static object MatchEnd(string outcome) => new
    {
        type = "matchEnd",
        outcome,
    };

    public static object PeerLeft() => new
    {
        type = "peerLeft",
    };

    public static object PeerReconnecting() => new
    {
        type = "peerReconnecting",
    };

    public static object PeerResumed() => new
    {
        type = "peerResumed",
    };

    public static object MatchResume(string phase, long endsAt, bool spotted) => new
    {
        type = "matchResume",
        phase,
        endsAt,
        spotted,
    };
}
