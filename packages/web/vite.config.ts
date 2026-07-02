import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@convex": path.resolve(__dirname, "../../convex"),
      // Canonical annotation engine lives in the extension package because
      // extension pages can only load files inside their own directory.
      "@shared": path.resolve(__dirname, "../extension/shared"),
    },
  },
});
