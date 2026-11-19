import Link from "next/link";
import { Badge } from "../components/badge";
import { listIncidents } from "../lib/api";
import { dateTime, TONE_CLASSES, TONE_LABEL } from "../lib/view";

export const dynamic = "force-dynamic";

export default async function IncidentsPage() {
  const incidents = await listIncidents();
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Incidents</h1>
      {incidents.length === 0 ? (
        <p className="mt-6 text-slate-600 dark:text-slate-400">No investigations yet. Run one with the CLI, the MCP server or the API and it will appear here.</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Recent incidents, newest first</caption>
            <thead className="border-b border-slate-200 text-slate-600 dark:border-slate-800 dark:text-slate-400">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">Severity</th>
                <th scope="col" className="py-2 pr-4 font-medium">Incident</th>
                <th scope="col" className="py-2 pr-4 font-medium">Target</th>
                <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                <th scope="col" className="py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((i) => (
                <tr key={i.id} className="border-b border-slate-100 align-top dark:border-slate-900">
                  <td className="py-3 pr-4">
                    <Badge className={TONE_CLASSES[i.severity]}>{TONE_LABEL[i.severity]}</Badge>
                  </td>
                  <td className="py-3 pr-4">
                    <Link href={`/incidents/${i.id}`} className="font-medium underline-offset-2 hover:underline">
                      {i.title}
                    </Link>
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs">{i.service ? `${i.namespace}/${i.service}` : i.namespace}</td>
                  <td className="py-3 pr-4 capitalize">{i.status}</td>
                  <td className="py-3 whitespace-nowrap">{dateTime(i.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
