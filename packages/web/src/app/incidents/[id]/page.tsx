import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "../../../components/badge";
import { getIncident } from "../../../lib/api";
import { CONFIDENCE_CLASSES, dateTime, hypothesisCards, timelineRows, TONE_CLASSES, TONE_LABEL } from "../../../lib/view";

export const dynamic = "force-dynamic";

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const incident = await getIncident(id);
  if (!incident) notFound();

  const rows = timelineRows(incident.timeline);
  const causes = hypothesisCards(incident.timeline);
  const target = incident.service ? `${incident.namespace}/${incident.service}` : incident.namespace;

  return (
    <>
      <p className="text-sm">
        <Link href="/" className="underline-offset-2 hover:underline">
          ← All incidents
        </Link>
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Badge className={TONE_CLASSES[incident.severity]}>{TONE_LABEL[incident.severity]}</Badge>
        <h1 className="text-2xl font-semibold tracking-tight">{incident.title}</h1>
      </div>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        <span className="font-mono">{target}</span> · {dateTime(incident.windowFrom)} to {dateTime(incident.windowTo)} · <span className="capitalize">{incident.status}</span>
      </p>

      {incident.timeline.errors.length > 0 && (
        <div role="alert" className="mt-6 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-medium">Some sources could not be read, so this picture is incomplete.</p>
          <ul className="mt-1 list-disc pl-5">
            {incident.timeline.errors.map((e) => (
              <li key={e.source}>
                <span className="font-mono">{e.source}</span>: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="mt-10" aria-labelledby="causes">
        <h2 id="causes" className="text-lg font-semibold">Likely causes</h2>
        {causes.length === 0 ? (
          <p className="mt-2 text-slate-600 dark:text-slate-400">The evidence does not match any known pattern.</p>
        ) : (
          <ol className="mt-4 space-y-4">
            {causes.map((c) => (
              <li key={c.id} className="rounded-md border border-slate-200 p-4 dark:border-slate-800">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {c.number}. {c.title}
                  </span>
                  <Badge className={CONFIDENCE_CLASSES[c.confidence]}>{c.confidence} confidence</Badge>
                </div>
                <p className="mt-1 text-sm">{c.rationale}</p>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Based on evidence {c.cites.map((n) => `[${n}]`).join(" ")}</p>
                <ul className="mt-2 list-disc pl-5 text-sm">
                  {c.checks.map((check) => (
                    <li key={check}>{check}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="mt-10" aria-labelledby="timeline">
        <h2 id="timeline" className="text-lg font-semibold">Timeline ({rows.length})</h2>
        {rows.length === 0 ? (
          <p className="mt-2 text-slate-600 dark:text-slate-400">No evidence of a problem was found in this window.</p>
        ) : (
          <ol className="mt-4 divide-y divide-slate-100 dark:divide-slate-900">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3 text-sm md:grid md:grid-cols-[2.5rem_5rem_5.5rem_6.5rem_minmax(0,1fr)_auto] md:gap-x-3">
                <span className="font-mono text-slate-500">[{r.number}]</span>
                <time className="font-mono">{r.clock}</time>
                <span>
                  <Badge className={TONE_CLASSES[r.tone]}>{TONE_LABEL[r.tone]}</Badge>
                </span>
                <span className="font-mono text-xs text-slate-600 dark:text-slate-400">{r.source}</span>
                <span className="min-w-0 break-words">{r.summary}</span>
                {r.citedBy.length > 0 && <span className="text-xs text-slate-600 dark:text-slate-400">cause {r.citedBy.join(", ")}</span>}
              </li>
            ))}
          </ol>
        )}
        <p className="mt-2 text-xs text-slate-500">Times are UTC.</p>
      </section>
    </>
  );
}
