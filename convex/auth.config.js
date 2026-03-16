const clerkIssuer =
  process.env.CLERK_ISSUER ||
  process.env.CLERK_JWT_ISSUER_DOMAIN ||
  "https://relaxing-fox-80.clerk.accounts.dev";

export default {
  providers: [
    {
      domain: clerkIssuer,
      applicationID: "convex",
    },
  ]
};
