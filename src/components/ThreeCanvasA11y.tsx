import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'

interface ThreeCanvasA11yProps {
  label: string
}

/** Applies the accessible name to the real WebGL canvas, not only its wrapper. */
export default function ThreeCanvasA11y({ label }: ThreeCanvasA11yProps) {
  const canvas = useThree((state) => state.gl.domElement)

  useEffect(() => {
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', label)
    return () => {
      canvas.removeAttribute('role')
      canvas.removeAttribute('aria-label')
    }
  }, [canvas, label])

  return null
}
