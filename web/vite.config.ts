import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // The SPA is served by the marketing-site server (serve.ts) under /app/* on
  // both dev and live domains, so asset URLs must be prefixed /app/.
  base: "/app/",
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
