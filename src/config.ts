const config = {
  port: parseInt(process.env.PORT ?? "3000", 10),
} as const;

export default config;
