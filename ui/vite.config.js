import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Vite dev server runs on 5173 and proxies /api/* to FastAPI on 8000.
// Source video streaming also goes through this proxy so range requests work.
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            "/api": {
                target: "http://localhost:8000",
                changeOrigin: true,
            },
        },
    },
});
