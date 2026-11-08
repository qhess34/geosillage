import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ProjectList from './ProjectList'
import ProjectView from './ProjectView'
import { t, useLang } from './i18n'
import './styles.css'

// Route: #/p/<projectId> or home
function useHashRoute(): [string | null, (id: string | null) => void] {
  const read = () => {
    const m = location.hash.match(/^#\/p\/([0-9a-f]+)$/)
    return m ? m[1] : null
  }
  const [id, setId] = useState(read)
  useEffect(() => {
    const on = () => setId(read())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return [id, (v) => (location.hash = v ? `#/p/${v}` : '')]
}

function App() {
  useLang()
  const [projectId, setProjectId] = useHashRoute()
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem('pss-theme') || 'auto'
    } catch {
      return 'auto'
    }
  })
  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem('pss-theme', theme)
    } catch {
      /* ignore */
    }
  }, [theme])

  return (
    <>
      <button
        className="theme-toggle small"
        onClick={() => setTheme(theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto')}
        title={t('theme.title')}
      >
        {theme === 'auto' ? t('theme.auto') : theme === 'dark' ? t('theme.dark') : t('theme.light')}
      </button>
      {projectId ? (
        <ProjectView key={projectId} projectId={projectId} onBack={() => setProjectId(null)} />
      ) : (
        <ProjectList onOpen={setProjectId} />
      )}
    </>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
