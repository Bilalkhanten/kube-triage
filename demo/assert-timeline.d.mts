export const EXPECTED: { app: string; cause: string }[];
export const LOG_EXPECTED: { app: string; message: string; secret: string };
export function checkTimeline(timeline: unknown): string[];
