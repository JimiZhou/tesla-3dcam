import { useEffect, useMemo } from 'react'
import { RoundedBox } from '@react-three/drei'
import * as THREE from 'three'

const VEHICLE_COLORS = {
  tire: '#181b1a',
  wheelMetal: '#a8acab',
  wheelHub: '#393e3d',
  egoBody: '#f4f5f3',
  egoTrim: '#eef0ed',
  egoGlass: '#182022',
  handle: '#777d7b',
  headlight: '#eef4e9',
  headlightGlow: '#dbe7d4',
  tailLight: '#d94c42',
  tailLightGlow: '#8f1d1d',
  plate: '#252a29',
  mirror: '#f0f1ef',
  trafficBody: '#c3c7c5',
  trafficGlass: '#39434a',
  trafficTire: '#222625',
} as const

function silhouetteGeometry(points: Array<[number, number]>, height: number, bevel = 0.08) {
  const shape = new THREE.Shape()
  points.forEach(([x, z], index) => {
    if (index === 0) shape.moveTo(x, z)
    else shape.lineTo(x, z)
  })
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize: bevel,
    bevelThickness: bevel,
    curveSegments: 5,
  })
  geometry.rotateX(-Math.PI / 2)
  geometry.computeVertexNormals()
  return geometry
}

function Wheel({ x, z, steering = 0 }: { x: number; z: number; steering?: number }) {
  return (
    <group position={[x, 0.34, z]} rotation={[0, steering, 0]}>
      <mesh rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.355, 0.355, 0.19, 24]} />
        <meshStandardMaterial color={VEHICLE_COLORS.tire} roughness={0.76} metalness={0.05} />
      </mesh>
      <mesh position={[x > 0 ? 0.101 : -0.101, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.215, 0.215, 0.012, 18]} />
        <meshStandardMaterial color={VEHICLE_COLORS.wheelMetal} roughness={0.34} metalness={0.82} />
      </mesh>
      <mesh position={[x > 0 ? 0.109 : -0.109, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.06, 0.06, 0.014, 16]} />
        <meshStandardMaterial color={VEHICLE_COLORS.wheelHub} roughness={0.3} metalness={0.62} />
      </mesh>
    </group>
  )
}

/** Model 3-proportioned local model; no external or unlicensed mesh is used. */
export function TeslaEgoModel({ steeringDeg = 0 }: { steeringDeg?: number }) {
  const body = useMemo(() => silhouetteGeometry([
    [-0.60, 2.36], [-0.82, 2.25], [-0.94, 1.90], [-0.96, 1.18],
    [-0.93, -1.52], [-0.82, -2.10], [-0.58, -2.34],
    [0.58, -2.34], [0.82, -2.10], [0.93, -1.52], [0.96, 1.18],
    [0.94, 1.90], [0.82, 2.25], [0.60, 2.36],
  ], 0.43, 0.07), [])

  useEffect(() => () => {
    body.dispose()
  }, [body])

  const steering = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(steeringDeg * 0.28, -28, 28))
  return (
    <group>
      <mesh geometry={body} position={[0, 0.22, 0]} castShadow receiveShadow>
        <meshPhysicalMaterial color={VEHICLE_COLORS.egoBody} roughness={0.23} metalness={0.42} clearcoat={0.82} clearcoatRoughness={0.16} />
      </mesh>

      <mesh position={[0, 0.61, -1.35]} scale={[0.91, 0.2, 1.18]} castShadow>
        <sphereGeometry args={[1, 30, 14, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshPhysicalMaterial color={VEHICLE_COLORS.egoBody} roughness={0.2} metalness={0.4} clearcoat={0.86} clearcoatRoughness={0.14} />
      </mesh>
      <mesh position={[0, 0.62, 1.58]} scale={[0.91, 0.23, 0.78]} castShadow>
        <sphereGeometry args={[1, 30, 14, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshPhysicalMaterial color={VEHICLE_COLORS.egoBody} roughness={0.2} metalness={0.4} clearcoat={0.86} clearcoatRoughness={0.14} />
      </mesh>
      <mesh position={[0, 0.62, 0.02]} scale={[0.75, 0.54, 1.29]} castShadow>
        <sphereGeometry args={[1, 36, 18, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshPhysicalMaterial color={VEHICLE_COLORS.egoGlass} roughness={0.11} metalness={0.24} clearcoat={0.92} clearcoatRoughness={0.1} />
      </mesh>

      {[-0.79, 0.79].flatMap((x) => [-0.84, 0.94].map((z) => (
        <mesh key={`pillar-${x}-${z}`} position={[x, 0.82, z]} rotation={[0, x * z * 0.08, x * -0.12]} castShadow>
          <boxGeometry args={[0.075, 0.09, 0.62]} />
          <meshPhysicalMaterial color={VEHICLE_COLORS.egoTrim} roughness={0.2} metalness={0.34} clearcoat={0.72} />
        </mesh>
      )))}
      {[-0.975, 0.975].flatMap((x) => [-0.48, 0.64].map((z) => (
        <mesh key={`handle-${x}-${z}`} position={[x, 0.67, z]}>
          <boxGeometry args={[0.025, 0.035, 0.24]} />
          <meshStandardMaterial color={VEHICLE_COLORS.handle} roughness={0.3} metalness={0.62} />
        </mesh>
      )))}

      {[-0.63, 0.63].map((x) => (
        <mesh key={`head-${x}`} position={[x, 0.54, -2.31]} rotation={[0, x * 0.13, 0]}>
          <boxGeometry args={[0.48, 0.055, 0.035]} />
          <meshStandardMaterial color={VEHICLE_COLORS.headlight} emissive={VEHICLE_COLORS.headlightGlow} emissiveIntensity={0.55} />
        </mesh>
      ))}
      <mesh position={[0, 0.58, 2.31]}>
        <boxGeometry args={[1.48, 0.07, 0.035]} />
        <meshStandardMaterial color={VEHICLE_COLORS.tailLight} emissive={VEHICLE_COLORS.tailLightGlow} emissiveIntensity={0.42} />
      </mesh>
      <mesh position={[0, 0.38, -2.34]}>
        <boxGeometry args={[0.56, 0.11, 0.035]} />
        <meshStandardMaterial color={VEHICLE_COLORS.plate} roughness={0.62} />
      </mesh>

      {[-1.02, 1.02].map((x) => (
        <RoundedBox key={`mirror-${x}`} args={[0.22, 0.1, 0.38]} radius={0.06} smoothness={3} position={[x, 0.78, -0.54]} castShadow>
          <meshStandardMaterial color={VEHICLE_COLORS.mirror} roughness={0.26} metalness={0.36} />
        </RoundedBox>
      ))}
      <Wheel x={-0.94} z={-1.52} steering={steering} />
      <Wheel x={0.94} z={-1.52} steering={steering} />
      <Wheel x={-0.94} z={1.50} />
      <Wheel x={0.94} z={1.50} />
    </group>
  )
}

export function GenericRoadVehicle({
  width,
  length,
  kind,
  opacity = 1,
}: {
  width: number
  length: number
  kind: 'vehicle' | 'truck' | 'bus' | 'unknown'
  opacity?: number
}) {
  const isLarge = kind === 'truck' || kind === 'bus'
  const baseHeight = isLarge ? 1.3 : 0.54
  const cabinHeight = isLarge ? 0.62 : 0.43
  const cabinLength = isLarge ? Math.min(length * 0.72, 5.6) : Math.min(length * 0.5, 2.15)
  const wheelRadius = isLarge ? 0.42 : 0.31
  const axle = Math.max(0.55, length * 0.31)
  const side = width * 0.5 + 0.02
  return (
    <group>
      <RoundedBox args={[width, baseHeight, length]} radius={isLarge ? 0.13 : 0.2} smoothness={3} position={[0, baseHeight * 0.5 + 0.14, 0]} castShadow>
        <meshStandardMaterial color={VEHICLE_COLORS.trafficBody} roughness={0.38} metalness={0.28} transparent={opacity < 1} opacity={opacity} />
      </RoundedBox>
      <RoundedBox args={[width * 0.76, cabinHeight, cabinLength]} radius={0.13} smoothness={3} position={[0, baseHeight + cabinHeight * 0.36, isLarge ? length * 0.12 : 0]} castShadow>
        <meshStandardMaterial color={VEHICLE_COLORS.trafficGlass} roughness={0.22} metalness={0.2} transparent={opacity < 1} opacity={opacity} />
      </RoundedBox>
      {[-side, side].flatMap((x) => [-axle, axle].map((z) => (
        <mesh key={`${x}-${z}`} position={[x, wheelRadius, z]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[wheelRadius, wheelRadius, 0.14, 16]} />
          <meshStandardMaterial color={VEHICLE_COLORS.trafficTire} roughness={0.82} transparent={opacity < 1} opacity={opacity} />
        </mesh>
      )))}
    </group>
  )
}
