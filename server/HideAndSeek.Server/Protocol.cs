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
}

public static class ServerMessages
{
    public static object Room(string code, string role, bool isHost, bool guestConnected) => new
    {
        type = "room",
        code,
        role,
        isHost,
        guestConnected,
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

    public static object PeerLeft() => new
    {
        type = "peerLeft",
    };
}
