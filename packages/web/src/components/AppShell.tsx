import { useCallback, useState } from 'react'
import { Link, NavLink, Outlet, useLoaderData, useNavigation } from 'react-router'
import { Command, LogOut, Moon, Sun, SunMoon } from 'lucide-react'
import type { Me } from '@/lib/types'
import { api } from '@/lib/api'
import { toggleTheme, useTheme } from '@/components/theme'
import { CommandPalette } from '@/components/CommandPalette'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export function AppShell() {
  const { user } = useLoaderData() as { user: Me | null }
  const nav = useNavigation()
  const theme = useTheme()
  const [cmdOpen, setCmdOpen] = useState(false)

  // ⌘K / Ctrl-K opens the palette. Listener attached in a ref callback that returns its
  // cleanup (React 19) — no useEffect.
  const bindHotkeys = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function signOut() {
    try {
      await api.post('/api/auth/logout')
    } finally {
      window.location.href = '/login'
    }
  }

  const initials = (user?.name || user?.email || '?').trim().slice(0, 1).toUpperCase()

  return (
    <div ref={bindHotkeys} className="bp-app-bg min-h-screen">
      <div
        className={cn(
          'fixed inset-x-0 top-0 z-50 h-0.5 bg-primary transition-opacity duration-300',
          nav.state !== 'idle' ? 'animate-pulse opacity-100' : 'opacity-0',
        )}
      />
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link to="/dashboard" className="flex items-center gap-2 font-mono text-sm font-semibold tracking-tight">
            <span className="size-2.5 rounded-[3px] bg-primary shadow-[0_0_12px_1px_var(--primary)]" />
            glance
          </Link>
          {user && (
            <nav className="ml-2 hidden items-center gap-1 sm:flex">
              <NavItem to="/dashboard">Dashboard</NavItem>
              {user.role === 'superadmin' && <NavItem to="/admin">Admin</NavItem>}
            </nav>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="gap-2 text-muted-foreground"
              onClick={() => setCmdOpen(true)}
            >
              <Command className="size-3.5" />
              <span className="hidden sm:inline">Search</span>
              <kbd className="hidden rounded border bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground sm:inline">
                ⌘K
              </kbd>
            </Button>
            <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
              {theme === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />}
            </Button>
            {user ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account menu">
                    <Avatar className="size-7">
                      <AvatarFallback className="bg-primary/15 text-xs font-semibold text-primary">
                        {initials}
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel className="font-normal">
                    <div className="text-xs text-muted-foreground">Signed in as</div>
                    <div className="truncate font-medium">{user.email}</div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => toggleTheme()}>
                    <SunMoon />
                    Toggle theme
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => signOut()}
                  >
                    <LogOut />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button asChild size="sm">
                <Link to="/login">Sign in</Link>
              </Button>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Outlet />
      </main>
      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} user={user} />
    </div>
  )
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
          isActive
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )
      }
    >
      {children}
    </NavLink>
  )
}
