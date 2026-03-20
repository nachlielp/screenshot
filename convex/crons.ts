import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Clean up expired screenshots daily at 2 AM
crons.daily(
  "cleanup expired screenshots",
  { hourUTC: 2, minuteUTC: 0 },
  internal.screenshots.cleanupExpired
);

crons.daily(
  "cleanup expired slideshows",
  { hourUTC: 2, minuteUTC: 15 },
  internal.slideshows.cleanupExpired
);

export default crons;
