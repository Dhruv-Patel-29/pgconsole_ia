import { FlaskConical, ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'

export function DemoBanner() {
  return (
    <div className="flex h-10 items-center justify-center gap-2 bg-primary text-sm font-medium text-primary-foreground">
      <FlaskConical size={14} />
      <span>Demo mode &mdash; this is a sample database</span>
      {/* Points at Settings rather than the upstream quickstart: connections are added through
          the UI in this build, so the recovery is two clicks away and needs no external page. */}
      <Link
        to="/settings"
        className="inline-flex items-center gap-1 underline underline-offset-2 hover:opacity-90"
      >
        Add a connection
        <ArrowRight size={14} />
      </Link>
    </div>
  )
}
