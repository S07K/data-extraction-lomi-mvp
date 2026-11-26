import type { Progress, VersionStatus } from "@lomi/contracts";
import { STATUS_TEXT } from "@/lib/format";

export function StatusText({ status }: { status: VersionStatus }) {
  return <span className={`status status-${status}`}>{STATUS_TEXT[status]}</span>;
}

export function ProgressBar({ progress }: { progress: Progress | null }) {
  if (!progress || progress.total === 0) return <span className="faint">No values yet</span>;
  const pct = (n: number) => `${(n / progress.total) * 100}%`;
  const done = progress.total - progress.pending;
  return (
    <div>
      <div className="progress" role="img" aria-label={`${done} of ${progress.total} values reviewed`}>
        <span className="seg-approved" style={{ width: pct(progress.approved) }} />
        <span className="seg-corrected" style={{ width: pct(progress.corrected) }} />
        <span className="seg-carried" style={{ width: pct(progress.carriedOver) }} />
      </div>
      <div className="progress-label">
        {progress.pending > 0 ? (
          <>
            <strong>{progress.pending} to review</strong>, {done} of {progress.total} done
          </>
        ) : (
          <>All {progress.total} reviewed</>
        )}
      </div>
    </div>
  );
}
