import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'

// Two apps, one codebase: the play-money demo (game server, DEMO=1) or the onchain app (local chain).
const App = __DEMO__ ? lazy(() => import('./demo/DemoApp')) : lazy(() => import('./App'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <App />
    </Suspense>
  </StrictMode>,
)
