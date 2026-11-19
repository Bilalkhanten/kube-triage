import Link from "next/link";

export default function NotFound() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Incident not found</h1>
      <p className="mt-2">
        <Link href="/" className="underline underline-offset-2">
          Back to all incidents
        </Link>
      </p>
    </>
  );
}
