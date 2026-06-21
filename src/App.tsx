import Unit7Game from './Unit7Game'

// Local dev harness only. Lovable never imports this file - it imports
// Unit7Game.tsx directly. Use it to exercise the component's `config` prop.
export default function App() {
  return (
    <Unit7Game
      config={{
        startInIntro: true, // public build plays the factory cinematic on load
        initialZone: 'earth',
      }}
    />
  )
}
