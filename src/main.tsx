import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// StrictMode intentionally left ON: it mounts -> unmounts -> remounts the tree in
// dev, which is the strongest local test that <Unit7Game /> tears down cleanly
// (disposes the WebGL context, cancels rAF, removes listeners) and survives the
// kind of hot-reload / route churn it will see inside a Lovable host.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
