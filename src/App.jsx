import { HashRouter, Routes, Route } from 'react-router-dom'
import Home from './pages/Home.jsx'
import Viewer from './pages/Viewer.jsx'

export default function App() {
  return (
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/view" element={<Viewer />} />
      </Routes>
    </HashRouter>
  )
}
