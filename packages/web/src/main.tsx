import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { Toaster } from './components/ui/sonner'
import { routeConfig } from './router'
import './tailwind.css'

const router = createBrowserRouter(routeConfig)

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <RouterProvider router={router} />
    <Toaster richColors closeButton />
  </StrictMode>,
)
