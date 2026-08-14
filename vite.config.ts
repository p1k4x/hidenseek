import { defineConfig } from "vite";

export default defineConfig({
  // Docker builds with VITE_BASE=./ so assets work at both :8082/ and /hide/.
  base: process.env.VITE_BASE || "/",
  server: {
    host: true,
    port: 5173,
  },
});
