using HideAndSeek.Server;

var builder = WebApplication.CreateBuilder(args);

// Local `dotnet run` defaults to 5080; Docker sets ASPNETCORE_URLS (e.g. :8080).
if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("ASPNETCORE_URLS")))
{
    builder.WebHost.UseUrls("http://0.0.0.0:5080");
}

var rooms = new RoomManager();
builder.Services.AddSingleton(rooms);

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();
app.UseWebSockets();

app.Map("/ws", async (HttpContext context, RoomManager roomManager) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        await context.Response.WriteAsync("Expected WebSocket upgrade.");
        return;
    }

    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    await roomManager.HandleSocketAsync(socket, context.RequestAborted);
});

app.Run();
