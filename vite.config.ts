import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/origin_of_life_playground/",
  plugins: [react()]
});
