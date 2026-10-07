import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import SpamTest from './SpamTest.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SpamTest />
  </StrictMode>,
)
