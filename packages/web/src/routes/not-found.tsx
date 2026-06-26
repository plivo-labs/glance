import { Link } from 'react-router'

import { Button } from '@/components/ui/button'

export function Component() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <p className="font-mono text-7xl font-semibold text-primary">404</p>
      <h2 className="mt-4 text-2xl font-semibold tracking-tight text-foreground">
        Page not found
      </h2>
      <p className="mt-2 text-muted-foreground">
        That page or site doesn&apos;t exist.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Button asChild>
          <Link to="/dashboard">Back to dashboard</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link to="/login">Sign in</Link>
        </Button>
      </div>
    </div>
  )
}
