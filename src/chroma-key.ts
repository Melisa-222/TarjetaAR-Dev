import * as ecs from '@8thwall/ecs'

interface ChromaUniforms {
  chromaKeyColor: { value: [number, number, number] }
  chromaSimilarity: { value: number }
  chromaSmoothness: { value: number }
  chromaSpill: { value: number }
  chromaEnabled: { value: number }
}

const COLOR_NAMES: Record<string, [number, number, number]> = {
  green: [0, 1, 0],
  blue: [0, 0, 1],
  red: [1, 0, 0],
  magenta: [1, 0, 1],
  cyan: [0, 1, 1],
}

function hexToRgb(colorStr: string): [number, number, number] {
  if (!colorStr) return [0, 1, 0]
  const lower = colorStr.trim().toLowerCase()
  if (COLOR_NAMES[lower]) {
    return COLOR_NAMES[lower]
  }

  let hex = lower.replace('#', '')
  if (hex.startsWith('0x')) {
    hex = hex.substring(2)
  }

  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
  }

  if (hex.length === 6) {
    const num = parseInt(hex, 16)
    if (!isNaN(num)) {
      return [
        ((num >> 16) & 255) / 255,
        ((num >> 8) & 255) / 255,
        (num & 255) / 255,
      ]
    }
  }

  return [0, 1, 0]
}

let interactionRegistered = false
function setupAutoPlayOnInteraction(videoEl: HTMLVideoElement) {
  if (interactionRegistered) return
  interactionRegistered = true

  const resumeVideo = () => {
    if (videoEl && videoEl.paused) {
      videoEl.play().catch(() => {})
    }
  }

  window.addEventListener('pointerdown', resumeVideo, { once: true })
}

ecs.registerComponent({
  name: 'chroma-key',
  schema: {
    enabled: ecs.boolean,
    keyColor: ecs.string,
    similarity: ecs.f32,
    smoothness: ecs.f32,
    spill: ecs.f32,
  },
  schemaDefaults: {
    enabled: true,
    keyColor: '#00FF00',
    similarity: 0.4,
    smoothness: 0.08,
    spill: 0.5,
  },
  add: (world, cursor) => {
    // Initial setup if mesh is immediately ready
  },
  tick: (world, cursor) => {
    const obj = world.three?.entityToObject?.get(cursor.eid)
    if (!obj) return

    const rgb = hexToRgb(cursor.schema.keyColor)

    obj.traverse((child: any) => {
      if (child.isMesh && child.material) {
        const materials = Array.isArray(child.material) ? child.material : [child.material]
        for (const mat of materials) {
          if (!mat.userData._chromaKeyApplied) {
            const uniforms: ChromaUniforms = {
              chromaKeyColor: { value: rgb },
              chromaSimilarity: { value: cursor.schema.similarity },
              chromaSmoothness: { value: cursor.schema.smoothness },
              chromaSpill: { value: cursor.schema.spill },
              chromaEnabled: { value: cursor.schema.enabled ? 1.0 : 0.0 },
            }
            mat.userData._chromaUniforms = uniforms
            mat.userData._chromaKeyApplied = true

            // Set Three.js transparency flags
            mat.transparent = true
            mat.depthWrite = false
            mat.side = 2 // THREE.DoubleSide

            // Unique cache key for program compilation
            mat.customProgramCacheKey = () => `chroma-key-shader-${mat.id || 'default'}`

            mat.onBeforeCompile = (shader: any) => {
              shader.uniforms.chromaKeyColor = uniforms.chromaKeyColor
              shader.uniforms.chromaSimilarity = uniforms.chromaSimilarity
              shader.uniforms.chromaSmoothness = uniforms.chromaSmoothness
              shader.uniforms.chromaSpill = uniforms.chromaSpill
              shader.uniforms.chromaEnabled = uniforms.chromaEnabled

              shader.fragmentShader = shader.fragmentShader.replace(
                '#include <map_pars_fragment>',
                `#include <map_pars_fragment>
                uniform vec3 chromaKeyColor;
                uniform float chromaSimilarity;
                uniform float chromaSmoothness;
                uniform float chromaSpill;
                uniform float chromaEnabled;
                `
              )

              shader.fragmentShader = shader.fragmentShader.replace(
                '#include <map_fragment>',
                `#include <map_fragment>
                #ifdef USE_MAP
                if (chromaEnabled > 0.5) {
                  vec3 col = diffuseColor.rgb;

                  // YCbCr (ITU-R BT.601) Chroma conversion for lighting-invariant comparison
                  float kCb = -0.168736 * chromaKeyColor.r - 0.331264 * chromaKeyColor.g + 0.500000 * chromaKeyColor.b;
                  float kCr =  0.500000 * chromaKeyColor.r - 0.418688 * chromaKeyColor.g - 0.081312 * chromaKeyColor.b;

                  float pCb = -0.168736 * col.r - 0.331264 * col.g + 0.500000 * col.b;
                  float pCr =  0.500000 * col.r - 0.418688 * col.g - 0.081312 * col.b;

                  float chromaDist = distance(vec2(pCb, pCr), vec2(kCb, kCr));

                  float edge0 = chromaSimilarity;
                  float edge1 = chromaSimilarity + max(chromaSmoothness, 0.0001);
                  float alphaVal = smoothstep(edge0, edge1, chromaDist);

                  diffuseColor.a *= alphaVal;

                  // Despill (Suppression of green/blue color bleed on subject edges)
                  if (chromaKeyColor.g > chromaKeyColor.r && chromaKeyColor.g > chromaKeyColor.b) {
                    float maxRB = max(diffuseColor.r, diffuseColor.b);
                    if (diffuseColor.g > maxRB) {
                      float excess = diffuseColor.g - maxRB;
                      diffuseColor.g -= excess * chromaSpill;
                    }
                  } else if (chromaKeyColor.b > chromaKeyColor.r && chromaKeyColor.b > chromaKeyColor.g) {
                    float maxRG = max(diffuseColor.r, diffuseColor.g);
                    if (diffuseColor.b > maxRG) {
                      float excess = diffuseColor.b - maxRG;
                      diffuseColor.b -= excess * chromaSpill;
                    }
                  }

                  if (diffuseColor.a < 0.005) {
                    discard;
                  }
                }
                #endif
                `
              )
            }

            mat.needsUpdate = true
          }

          // If the map/texture arrived asynchronously after material creation, trigger update
          if (!mat.userData._hadMap && mat.map) {
            mat.userData._hadMap = true
            mat.needsUpdate = true
          }

          // Update uniform values in real-time
          const uniforms: ChromaUniforms | undefined = mat.userData._chromaUniforms
          if (uniforms) {
            uniforms.chromaKeyColor.value[0] = rgb[0]
            uniforms.chromaKeyColor.value[1] = rgb[1]
            uniforms.chromaKeyColor.value[2] = rgb[2]
            uniforms.chromaSimilarity.value = cursor.schema.similarity
            uniforms.chromaSmoothness.value = cursor.schema.smoothness
            uniforms.chromaSpill.value = cursor.schema.spill
            uniforms.chromaEnabled.value = cursor.schema.enabled ? 1.0 : 0.0
          }

          // Setup interaction autoplay if blocked by mobile browser
          if (mat.map && mat.map.image instanceof HTMLVideoElement) {
            setupAutoPlayOnInteraction(mat.map.image)
          }
        }
      }
    })
  },
  remove: (world, cursor) => {
    const obj = world.three?.entityToObject?.get(cursor.eid)
    if (obj) {
      obj.traverse((child: any) => {
        if (child.isMesh && child.material) {
          const materials = Array.isArray(child.material) ? child.material : [child.material]
          for (const mat of materials) {
            if (mat.userData._chromaUniforms) {
              mat.userData._chromaUniforms.chromaEnabled.value = 0.0
            }
          }
        }
      })
    }
  },
})
