import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App.js'
import { applyThemeToDocument, readStoredTheme } from './hooks/useTheme.js'
import './index.css'

applyThemeToDocument(readStoredTheme())

const rootElement = document.getElementById('root')

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
