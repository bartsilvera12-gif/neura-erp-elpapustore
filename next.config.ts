import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Salida standalone para el Dockerfile (node server.js): la imagen solo lleva el
  // subconjunto de node_modules que Next rastreó → mucha menos RAM que `next start`.
  output: "standalone",
};

export default nextConfig;
