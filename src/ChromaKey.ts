import * as ecs from '@8thwall/ecs'
import {setMaterialEffect, removeMaterialEffect} from './material-effects'
import type {EffectMesh, MaterialEffect, Uniform} from './material-effects'

type Binding = {
  mesh: EffectMesh
  effect: MaterialEffect
  uniforms: {
    chromaKeyColor: Uniform<[number, number, number]>
    chromaTolerance: Uniform<number>
    chromaSoftness: Uniform<number>
    chromaSpill: Uniform<number>
    chromaEnabled: Uniform<number>
  }
}

const bindings = new WeakMap<ecs.World, Map<bigint, Binding>>()

function parseRgb(schema: any): [number, number, number] {
  // 1. If keyColor string is provided and non-empty (Studio color picker / eyedropper)
  if (schema.keyColor && typeof schema.keyColor === 'string' && schema.keyColor.trim().length > 0) {
    let clean = schema.keyColor.replace('#', '').trim()
    if (clean.startsWith('0x')) clean = clean.substring(2)
    if (clean.length === 3) {
      clean = clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2]
    }
    if (clean.length === 6) {
      const num = parseInt(clean, 16)
      if (!isNaN(num)) {
        return [
          ((num >> 16) & 255) / 255,
          ((num >> 8) & 255) / 255,
          (num & 255) / 255,
        ]
      }
    }
  }

  // 2. If separate red, green, blue channels are provided
  if (
    typeof schema.keyRed === 'number' && !isNaN(schema.keyRed) &&
    typeof schema.keyGreen === 'number' && !isNaN(schema.keyGreen) &&
    typeof schema.keyBlue === 'number' && !isNaN(schema.keyBlue)
  ) {
    return [
      Math.max(0, Math.min(255, schema.keyRed)) / 255,
      Math.max(0, Math.min(255, schema.keyGreen)) / 255,
      Math.max(0, Math.min(255, schema.keyBlue)) / 255,
    ]
  }

  // Default: Pure Green
  return [0, 1, 0]
}

function findMesh(obj: any): any {
  if (!obj) return null
  if (obj.isMesh && obj.material) return obj
  let found: any = null
  obj.traverse?.((child: any) => {
    if (!found && child.isMesh && child.material) {
      found = child
    }
  })
  return found
}

const release = (instances: Map<bigint, Binding>, eid: bigint) => {
  const binding = instances.get(eid)
  if (!binding) return

  removeMaterialEffect(binding.mesh, 'chroma-key', binding.effect)
  instances.delete(eid)
}

const CHROMA_PARS = `
#include <map_pars_fragment>
uniform vec3 chromaKeyColor;
uniform float chromaTolerance;
uniform float chromaSoftness;
uniform float chromaSpill;
uniform float chromaEnabled;

// Three.js decodes video textures into Linear color space when DECODE_VIDEO_TEXTURE is active.
// We convert back to sRGB so color comparison matches the sRGB color picker.
vec3 chromaLinearToSrgb(vec3 color) {
  return mix(
    12.92 * color,
    1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
    step(vec3(0.0031308), color)
  );
}

// YCbCr chrominance representation (luminance-invariant)
vec2 chromaGetCbCr(vec3 col) {
  return vec2(
    dot(col, vec3(-0.168736, -0.331264,  0.500000)),
    dot(col, vec3( 0.500000, -0.418688, -0.081312))
  );
}
`

const CHROMA_BODY = `
#include <map_fragment>
#ifdef USE_MAP
if (chromaEnabled > 0.5) {
  vec3 srgbCol = chromaLinearToSrgb(diffuseColor.rgb);

  // Detect whether we are keying against a green or blue screen
  bool isGreenKey = chromaKeyColor.g > chromaKeyColor.r && chromaKeyColor.g > chromaKeyColor.b;
  bool isBlueKey  = chromaKeyColor.b > chromaKeyColor.r && chromaKeyColor.b > chromaKeyColor.g;

  float keyExcess = 1.0;
  float maxOther = max(srgbCol.r, srgbCol.b);
  if (isGreenKey) {
    keyExcess = srgbCol.g - maxOther;
  } else if (isBlueKey) {
    maxOther = max(srgbCol.r, srgbCol.g);
    keyExcess = srgbCol.b - maxOther;
  }

  // 1. FOREGROUND SHIELD:
  // If the key color does not dominate other channels, this pixel is NOT part
  // of the backing screen. This permanently protects blacks, dark shadows,
  // skin tones, clothes, sparks, and warm colors regardless of tolerance setting.
  if (keyExcess <= 0.0) {
    // 100% solid foreground - do not key out
  } else {
    vec2 pChroma = chromaGetCbCr(srgbCol);
    vec2 kChroma = chromaGetCbCr(chromaKeyColor);
    float chromaDist = distance(pChroma, kChroma);

    // Excess factor smoothly ramps up from light spill level (0.02) to full background (0.10).
    // Dark elements with slight color spill remain solid!
    float excessFactor = smoothstep(0.02, 0.10, keyExcess);

    // Distance factor (0 near key color, 1 far away)
    float edge0 = chromaTolerance;
    float edge1 = chromaTolerance + max(chromaSoftness, 0.001);
    float distFactor = smoothstep(edge0, edge1, chromaDist);

    // Remove pixel only when BOTH chroma matches AND key channel dominance is strong
    float keyStrength = (1.0 - distFactor) * excessFactor;
    diffuseColor.a *= (1.0 - keyStrength);

    // Discard keyed-out background pixels immediately so they don't block AR view
    if (diffuseColor.a <= 0.01) {
      discard;
    }

    // 2. DESPILL:
    // Suppress green or blue reflection on foreground edges
    if (chromaSpill > 0.0) {
      if (isGreenKey && diffuseColor.g > maxOther) {
        diffuseColor.g -= (diffuseColor.g - maxOther) * chromaSpill;
      } else if (isBlueKey && diffuseColor.b > maxOther) {
        diffuseColor.b -= (diffuseColor.b - maxOther) * chromaSpill;
      }
    }
  }
}
#endif
`

const CHROMA_OPAQUE = `
#ifdef USE_TRANSMISSION
diffuseColor.a *= material.transmissionAlpha;
#endif
gl_FragColor = vec4( outgoingLight, diffuseColor.a );
`

const attach = (mesh: EffectMesh): Binding => {
  const uniforms = {
    chromaKeyColor: {value: [0, 1, 0] as [number, number, number]},
    chromaTolerance: {value: 0.40},
    chromaSoftness: {value: 0.08},
    chromaSpill: {value: 0.7},
    chromaEnabled: {value: 1.0},
  }

  const effect: MaterialEffect = {
    cacheKey: 'chroma-key-v8',
    properties: {transparent: true, depthWrite: false, side: 2},
    compile: (shader) => {
      Object.assign(shader.uniforms, uniforms)

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <map_pars_fragment>', CHROMA_PARS)
        .replace('#include <map_fragment>', CHROMA_BODY)
        .replace('#include <opaque_fragment>', CHROMA_OPAQUE)
    },
  }

  return {mesh, effect, uniforms}
}

ecs.registerComponent({
  name: 'Chroma Key',

  schema: {
    // @label Enabled
    enabled: ecs.boolean,

    // @group start keyColor:color
    // @label Red
    keyRed: ecs.ui8,
    // @label Green
    keyGreen: ecs.ui8,
    // @label Blue
    keyBlue: ecs.ui8,
    // @group end

    // Higher values remove more colors around the selected background color.
    // @label Tolerance
    // @min 0
    // @max 1
    tolerance: ecs.f32,

    // Width of the transition between transparent and opaque pixels.
    // @label Edge Softness
    // @min 0
    // @max 1
    softness: ecs.f32,

    // Neutralizes green/blue color spill on the subject edges.
    // @label Spill Suppression
    // @min 0
    // @max 1
    spill: ecs.f32,
  },

  schemaDefaults: {
    enabled: true,
    keyRed: 0,
    keyGreen: 255,
    keyBlue: 0,
    tolerance: 0.40,
    softness: 0.08,
    spill: 0.7,
  },

  tick: (world, {eid, schema}) => {
    let instances = bindings.get(world)
    if (!instances) {
      instances = new Map()
      bindings.set(world, instances)
    }

    // Only release if explicitly set to false (allow undefined to default to true)
    if ((schema as any).enabled === false) {
      release(instances, eid)
      return
    }

    // Ensure ECS material transparency is enabled for all material types
    if (ecs.Material.has(world, eid)) {
      const ecsMat = ecs.Material.get(world, eid) as any
      if (!ecsMat.forceTransparent) {
        ecs.Material.mutate(world, eid, (cursor) => {
          ;(cursor as any).forceTransparent = true
        })
      }
    }
    if ((ecs as any).UnlitMaterial?.has(world, eid)) {
      const ecsMat = (ecs as any).UnlitMaterial.get(world, eid) as any
      if (!ecsMat.forceTransparent) {
        (ecs as any).UnlitMaterial.mutate(world, eid, (cursor: any) => {
          cursor.forceTransparent = true
        })
      }
    }

    const rootObj = (world as any).three?.entityToObject?.get(eid)
    const mesh = findMesh(rootObj) as EffectMesh | null
    let binding = instances.get(eid)

    if (binding && binding.mesh !== mesh) {
      release(instances, eid)
      binding = undefined
    }

    if (!mesh?.isMesh || !mesh.material) {
      release(instances, eid)
      return
    }

    const mat: any = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    if (!mat) return

    // Ensure Three.js material has transparency enabled and forces recompile if needed
    if (!mat.transparent || mat.depthWrite !== false) {
      mat.transparent = true
      mat.depthWrite = false
      mat.needsUpdate = true
    }
    mat.side = 2

    if (!binding) {
      binding = attach(mesh)
      instances.set(eid, binding)
    }
    setMaterialEffect(mesh, 'chroma-key', binding.effect)

    const rgb = parseRgb(schema)
    const rawTol = typeof schema.tolerance === 'number' && !isNaN(schema.tolerance) ? schema.tolerance : 0.40
    const tolerance = rawTol > 0.001 ? rawTol : 0.40
    const rawSoft = typeof schema.softness === 'number' && !isNaN(schema.softness) ? schema.softness : 0.08
    const softness = rawSoft > 0.0001 ? rawSoft : 0.08
    const rawSpill = typeof schema.spill === 'number' && !isNaN(schema.spill) ? schema.spill : 0.7
    const spill = Math.max(0, Math.min(1, rawSpill))

    const {uniforms} = binding
    uniforms.chromaKeyColor.value[0] = rgb[0]
    uniforms.chromaKeyColor.value[1] = rgb[1]
    uniforms.chromaKeyColor.value[2] = rgb[2]
    uniforms.chromaTolerance.value = Math.max(0, Math.min(1, tolerance))
    uniforms.chromaSoftness.value = Math.max(0.0001, Math.min(1, softness))
    uniforms.chromaSpill.value = spill
    uniforms.chromaEnabled.value = ((schema as any).enabled !== false) ? 1.0 : 0.0

    // Ensure video texture element has playsInline set so mobile browsers decode properly
    if (mat.map?.image instanceof HTMLVideoElement) {
      if (!mat.map.image.playsInline) {
        mat.map.image.playsInline = true
      }
    }
  },

  remove: (world, {eid}) => {
    const instances = bindings.get(world)
    if (instances) release(instances, eid)
  },
})
