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

function setupVideoAutoPlay(videoEl: HTMLVideoElement) {
  videoEl.muted = true
  videoEl.playsInline = true
  videoEl.loop = true

  if (videoEl.paused) {
    videoEl.play().catch(() => {
      const onTouch = () => {
        videoEl.play().catch(() => {})
        window.removeEventListener('pointerdown', onTouch)
        window.removeEventListener('touchstart', onTouch)
      }
      window.addEventListener('pointerdown', onTouch, {once: true})
      window.addEventListener('touchstart', onTouch, {once: true})
    })
  }
}

function parseRgb(schema: any): [number, number, number] {
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

  if (schema.keyColor && typeof schema.keyColor === 'string') {
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

// Three.js decodes video textures into Linear color space.
// We convert back to sRGB to match the color picker coordinates.
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
  vec2 pChroma = chromaGetCbCr(srgbCol);
  vec2 kChroma = chromaGetCbCr(chromaKeyColor);

  float d = distance(pChroma, kChroma);

  float maxRB = max(srgbCol.r, srgbCol.b);
  float maxChannel = max(srgbCol.r, max(srgbCol.g, srgbCol.b));
  float lum = dot(srgbCol, vec3(0.299, 0.587, 0.114));
  float greenExcess = srgbCol.g - maxRB;

  // 1. Black / Shadow Protection:
  // Dark elements (black cat fur, dark clothes, pupils, outlines) often pick up
  // compression chroma noise or spill that makes them look slightly green.
  // Real green screens have high brightness (> 0.22) and strong green dominance.
  // Dark pixels must NEVER be keyed out, regardless of how high tolerance is set.
  if (maxChannel < 0.20 || lum < 0.16) {
    d += 2.0;
  }

  // 2. Color Dominance Protection:
  // If green is not strictly dominant over red and blue, this CANNOT be the green screen.
  // Preserves yellow/gold/orange sparks, warm fur, skin tones, etc.
  if (greenExcess <= 0.005) {
    d += 2.0;
  }

  // 3. Bright Highlight Protection:
  // White spark cores or highlights.
  if (min(srgbCol.r, min(srgbCol.g, srgbCol.b)) > 0.70) {
    d += 2.0;
  }

  float edge0 = chromaTolerance;
  float edge1 = chromaTolerance + max(chromaSoftness, 0.001);
  float alphaVal = smoothstep(edge0, edge1, d);

  diffuseColor.a *= alphaVal;

  // Discard keyed-out background pixels immediately
  if (diffuseColor.a <= 0.01) {
    discard;
  }

  // Despill: suppress green reflection ONLY on visible subject edges
  if (chromaSpill > 0.0 && chromaKeyColor.g > chromaKeyColor.r && chromaKeyColor.g > chromaKeyColor.b) {
    if (diffuseColor.g > maxRB) {
      float excess = diffuseColor.g - maxRB;
      diffuseColor.g -= excess * chromaSpill;
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
    chromaTolerance: {value: 0.35},
    chromaSoftness: {value: 0.08},
    chromaSpill: {value: 0.5},
    chromaEnabled: {value: 1.0},
  }

  const effect: MaterialEffect = {
    cacheKey: 'chroma-key-v7',
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
    tolerance: 0.35,
    softness: 0.08,
    spill: 0.5,
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

    // Force ECS material transparency
    if (ecs.Material.has(world, eid)) {
      const ecsMat = ecs.Material.get(world, eid) as any
      if (!ecsMat.forceTransparent) {
        ecs.Material.mutate(world, eid, (cursor) => {
          ;(cursor as any).forceTransparent = true
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

    mat.transparent = true
    mat.depthWrite = false
    mat.side = 2

    if (!binding) {
      binding = attach(mesh)
      instances.set(eid, binding)
    }
    setMaterialEffect(mesh, 'chroma-key', binding.effect)

    const rgb = parseRgb(schema)
    const rawTol = typeof schema.tolerance === 'number' && !isNaN(schema.tolerance) ? schema.tolerance : 0.35
    const tolerance = rawTol > 0.001 ? rawTol : 0.35
    const rawSoft = typeof schema.softness === 'number' && !isNaN(schema.softness) ? schema.softness : 0.08
    const softness = rawSoft > 0.0001 ? rawSoft : 0.08
    const rawSpill = typeof schema.spill === 'number' && !isNaN(schema.spill) ? schema.spill : 0.5
    const spill = Math.max(0, Math.min(1, rawSpill))

    const {uniforms} = binding
    uniforms.chromaKeyColor.value[0] = rgb[0]
    uniforms.chromaKeyColor.value[1] = rgb[1]
    uniforms.chromaKeyColor.value[2] = rgb[2]
    uniforms.chromaTolerance.value = Math.max(0, Math.min(1, tolerance))
    uniforms.chromaSoftness.value = Math.max(0.0001, Math.min(1, softness))
    uniforms.chromaSpill.value = spill
    uniforms.chromaEnabled.value = ((schema as any).enabled !== false) ? 1.0 : 0.0

    if (mat.map?.image instanceof HTMLVideoElement) {
      setupVideoAutoPlay(mat.map.image)
    }
  },

  remove: (world, {eid}) => {
    const instances = bindings.get(world)
    if (instances) release(instances, eid)
  },
})
