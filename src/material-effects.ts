export type Uniform<T> = {value: T}

export type MaterialEffect = {
  cacheKey: string
  properties?: {
    transparent?: boolean
    depthWrite?: boolean
    depthTest?: boolean
    side?: number
  }
  compile: (shader: any) => void
}

export type EffectMesh = any

const activeEffects = new WeakMap<any, Map<string, MaterialEffect>>()

export function setMaterialEffect(mesh: any, name: string, effect: MaterialEffect) {
  if (!mesh || !mesh.material) return
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]

  for (const mat of materials) {
    if (!mat.userData) mat.userData = {}
    let effects = activeEffects.get(mat)
    if (!effects) {
      effects = new Map()
      activeEffects.set(mat, effects)
    }

    if (effects.get(name) === effect) return
    effects.set(name, effect)

    if (effect.properties) {
      if (effect.properties.transparent !== undefined) mat.transparent = effect.properties.transparent
      if (effect.properties.depthWrite !== undefined) mat.depthWrite = effect.properties.depthWrite
      if (effect.properties.depthTest !== undefined) mat.depthTest = effect.properties.depthTest
      if (effect.properties.side !== undefined) mat.side = effect.properties.side
    }

    mat.customProgramCacheKey = () => {
      const keys = Array.from(effects!.values()).map(e => e.cacheKey).join('_')
      return `effect_${mat.id || 'mat'}_${keys}`
    }

    mat.onBeforeCompile = (shader: any) => {
      for (const e of effects!.values()) {
        e.compile(shader)
      }
    }

    mat.needsUpdate = true
  }
}

export function removeMaterialEffect(mesh: any, name: string, effect?: MaterialEffect) {
  if (!mesh || !mesh.material) return
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]

  for (const mat of materials) {
    const effects = activeEffects.get(mat)
    if (!effects || !effects.has(name)) continue
    effects.delete(name)

    if (effects.size === 0) {
      mat.onBeforeCompile = () => {}
      mat.customProgramCacheKey = () => `default_${mat.id || 'mat'}`
    } else {
      mat.customProgramCacheKey = () => {
        const keys = Array.from(effects.values()).map(e => e.cacheKey).join('_')
        return `effect_${mat.id || 'mat'}_${keys}`
      }
      mat.onBeforeCompile = (shader: any) => {
        for (const e of effects.values()) {
          e.compile(shader)
        }
      }
    }

    mat.needsUpdate = true
  }
}
