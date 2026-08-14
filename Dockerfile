# Client
FROM node:22-alpine AS client
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
ARG VITE_BASE=./
ENV VITE_BASE=$VITE_BASE
RUN npm run build

# Server
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS server
WORKDIR /src
COPY server/HideAndSeek.Server ./HideAndSeek.Server
RUN dotnet publish HideAndSeek.Server/HideAndSeek.Server.csproj -c Release -o /app/publish

# Runtime
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
COPY --from=server /app/publish .
COPY --from=client /app/dist ./wwwroot
ENV ASPNETCORE_URLS=http://0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "HideAndSeek.Server.dll"]
