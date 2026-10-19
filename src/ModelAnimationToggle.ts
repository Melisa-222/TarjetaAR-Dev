import * as ecs from '@8thwall/ecs'

type AnimationMode = 'idle' | 'action'
type LoadedModel = {animations: Array<{name: string; clone: () => any}>}

ecs.registerComponent({
  name: 'Model Animation Toggle',

  schema: {
    // Disables this controller; the model keeps its current animation.
    // @label Enabled
    enabled: ecs.boolean,
    // Leave empty to animate the object that owns this component.
    // @label Animation Target
    target: ecs.eid,
    // Optional: Select a second GLB entity to take the action animation from (e.g. maga_2.glb).
    // @label Action Model
    actionModel: ecs.eid,
    // Automatically hide the Action Model so only one character is visible in the scene.
    // @label Hide Action Model
    hideActionModel: ecs.boolean,
    // Clip name for Idle (default: mixamo.com or first animation in GLB).
    // @label Idle Animation
    idleClip: ecs.string,
    // Clip name for Action (default: maga_2 or second animation in GLB).
    // @label Action Animation
    actionClip: ecs.string,
    // @label Play Idle On Start
    playIdleOnStart: ecs.boolean,
    // If true, the action animation loops. If false, plays once and returns to idle.
    // @label Loop Action
    loopAction: ecs.boolean,
    // Only applies when Loop Action is off: automatically return to Idle when action finishes.
    // @label Return To Idle
    returnToIdle: ecs.boolean,
    // @label Idle Speed
    // @min 0.01
    idleSpeed: ecs.f32,
    // @label Action Speed
    // @min 0.01
    actionSpeed: ecs.f32,
    // Seconds used to blend from one animation to the other.
    // @label Cross Fade Duration
    // @min 0
    crossFadeDuration: ecs.f32,
    // Minimum seconds between accepted clicks. Zero disables the cooldown.
    // @label Click Cooldown
    // @min 0
    clickCooldown: ecs.f32,
  },

  schemaDefaults: {
    enabled: true,
    hideActionModel: true,
    idleClip: 'mixamo.com',
    actionClip: 'maga_2',
    playIdleOnStart: true,
    loopAction: false,
    returnToIdle: true,
    idleSpeed: 1,
    actionSpeed: 1,
    crossFadeDuration: 0.3,
    clickCooldown: 0.2,
  },

  stateMachine: ({world, eid, schemaAttribute}) => {
    let mode: AnimationMode | undefined
    let playingClip = ''
    let boundTarget = 0n
    let loadedModel: LoadedModel | undefined
    let wasEnabled = false
    let nextClickAt = 0
    let lastWarning = ''
    let actionFinished = false
    const taps = new Set<number>()
    const maxTapMovement = 0.06

    const getLoadedModel = (target: bigint) =>
      world.three.entityToObject.get(target)?.userData.gltf as LoadedModel | undefined

    const warn = (message: string) => {
      if (message !== lastWarning) console.warn(`Model Animation Toggle: ${message}`)
      lastWarning = message
    }

    const getTarget = () => {
      const configuredTarget = schemaAttribute.get(eid).target
      if (configuredTarget && configuredTarget !== eid && ecs.GltfModel.has(world, configuredTarget)) {
        const loaded = getLoadedModel(configuredTarget)
        if (loaded && loaded.animations && loaded.animations.length > 0) {
          return configuredTarget
        }
        const selfLoaded = getLoadedModel(eid)
        if (selfLoaded && selfLoaded.animations && selfLoaded.animations.length > 0) {
          return eid
        }
        return configuredTarget
      }
      return eid
    }

    // Finds the second model (maga_2) either from parameter or by searching the scene
    const getActionModelEid = (options: any): bigint | undefined => {
      if (options.actionModel && ecs.GltfModel.has(world, options.actionModel)) {
        return options.actionModel
      }
      for (const entity of world.allEntities) {
        if (entity === eid) continue
        if (ecs.GltfModel.has(world, entity)) {
          const gltfData = ecs.GltfModel.get(world, entity)
          const url = (gltfData.url || '').toLowerCase()
          if (url.includes('maga_2') || url.includes('maga2')) {
            return entity
          }
        }
      }
      return undefined
    }

    // Imports the animation clip from actionModel (maga_2) into target (Maga_1)
    const importActionAnimationIfNeeded = () => {
      const options = schemaAttribute.get(eid)
      const target = getTarget()
      const targetLoaded = getLoadedModel(target)
      if (!targetLoaded?.animations) return

      const actionEid = getActionModelEid(options)
      if (!actionEid) return

      const actionLoaded = getLoadedModel(actionEid)
      if (!actionLoaded?.animations?.length) return

      const actionClipName = (options.actionClip || 'maga_2').trim()

      if (!targetLoaded.animations.some(a => a.name === actionClipName)) {
        const sourceClip = actionLoaded.animations[0]
        const cloned = sourceClip.clone()
        cloned.name = actionClipName
        targetLoaded.animations.push(cloned)
        console.log(`[Model Animation Toggle] Animación de maga_2 importada como "${actionClipName}".`)
      }

      if (options.hideActionModel !== false) {
        const actionObj = world.three.entityToObject.get(actionEid)
        if (actionObj && actionObj.visible) {
          actionObj.visible = false
        }
      }
    }

    const resolveClip = (requestedName: string, role: AnimationMode, loaded: LoadedModel): string => {
      if (!loaded.animations || loaded.animations.length === 0) return ''
      const trimmed = (requestedName || '').trim()

      if (trimmed) {
        const exact = loaded.animations.find(a => a.name === trimmed)
        if (exact) return exact.name

        const lower = trimmed.toLowerCase()
        const caseMatch = loaded.animations.find(a => a.name.toLowerCase() === lower)
        if (caseMatch) return caseMatch.name

        const partial = loaded.animations.find(
          a => a.name.toLowerCase().includes(lower) || lower.includes(a.name.toLowerCase())
        )
        if (partial) return partial.name
      }

      if (role === 'idle') {
        const fallback = loaded.animations[0]?.name || ''
        if (trimmed && trimmed !== fallback) {
          warn(`Clip "${trimmed}" no encontrado. Usando "${fallback}" como Idle. Disponibles: ${loaded.animations.map(a => a.name).join(', ')}`)
        }
        return fallback
      } else {
        const options = schemaAttribute.get(eid)
        const idleResolved = resolveClip(options.idleClip, 'idle', loaded)
        const secondary = loaded.animations.find(a => a.name !== idleResolved)
        const fallback = secondary ? secondary.name : (loaded.animations[0]?.name || '')
        if (trimmed && trimmed !== fallback) {
          warn(`Clip "${trimmed}" no encontrado. Usando "${fallback}" como Action. Disponibles: ${loaded.animations.map(a => a.name).join(', ')}`)
        }
        return fallback
      }
    }

    const play = (next: AnimationMode) => {
      const options = schemaAttribute.get(eid)
      if (!options.enabled) return false
      const target = getTarget()
      if (!ecs.GltfModel.has(world, target)) {
        warn('Animation Target must be a GLB model. Leave it empty to use this object.')
        return false
      }
      importActionAnimationIfNeeded()
      const loaded = getLoadedModel(target)
      if (!loaded) return false
      if (!loaded.animations || loaded.animations.length === 0) {
        warn('El modelo GLB no contiene ninguna animación.')
        return false
      }

      const clip = resolveClip(next === 'idle' ? options.idleClip : options.actionClip, next, loaded)
      if (!clip) {
        warn('No se pudo encontrar ninguna animación válida.')
        return false
      }
      lastWarning = ''

      ecs.GltfModel.mutate(world, target, (model) => {
        model.animationClip = clip
        model.loop = next === 'idle' || options.loopAction
        model.repetitions = 0
        model.reverse = false
        model.paused = false
        model.time = 0
        model.timeScale = Math.fround(Math.max(0.01, next === 'idle' ? options.idleSpeed : options.actionSpeed))
        model.crossFadeDuration = Math.max(0, options.crossFadeDuration)
      })
      mode = next
      playingClip = clip
      actionFinished = false
      return true
    }

    const sync = () => {
      const options = schemaAttribute.get(eid)
      const target = getTarget()
      importActionAnimationIfNeeded()
      const loaded = getLoadedModel(target)

      if (target !== boundTarget || loaded !== loadedModel || options.enabled !== wasEnabled) {
        mode = undefined
        playingClip = ''
        actionFinished = false
        nextClickAt = 0
        taps.clear()
        lastWarning = ''
        boundTarget = target
        loadedModel = loaded
        wasEnabled = options.enabled
      }
      if (!options.enabled) return
      if (!mode) {
        if (options.playIdleOnStart) play('idle')
        return
      }
      if (!ecs.GltfModel.has(world, target)) return
      const model = ecs.GltfModel.get(world, target)
      if (model.animationClip !== playingClip) return
      if (mode === 'action' && actionFinished && !options.loopAction && options.returnToIdle) {
        play('idle')
        return
      }
      if (!loaded) return
      const clip = resolveClip(mode === 'idle' ? options.idleClip : options.actionClip, mode, loaded)
      if (clip !== playingClip) {
        play(mode)
        return
      }
      const speed = Math.fround(Math.max(0.01, mode === 'idle' ? options.idleSpeed : options.actionSpeed))
      const loop = mode === 'idle' || options.loopAction
      const fade = Math.max(0, options.crossFadeDuration)
      if (model.timeScale !== speed || model.loop !== loop || model.crossFadeDuration !== fade) {
        ecs.GltfModel.mutate(world, target, (cursor) => {
          cursor.timeScale = speed
          cursor.loop = loop
          cursor.crossFadeDuration = fade
        })
        if (loop) actionFinished = false
      }
    }

    const hitsModel = (entity: bigint | undefined) => {
      const target = getTarget()
      const actionEid = getActionModelEid(schemaAttribute.get(eid))
      for (let current = entity; current; current = world.getParent(current)) {
        if (ecs.Ui.has(world, current)) return false
        if (current === eid || current === target || current === actionEid) return true
      }
      return false
    }

    const toggle = () => {
      sync()
      const options = schemaAttribute.get(eid)
      if (!options.enabled || world.time.elapsed < nextClickAt) return
      const target = getTarget()
      const loaded = getLoadedModel(target)

      if (loaded && loaded.animations) {
        const idleResolved = resolveClip(options.idleClip, 'idle', loaded)
        const actionResolved = resolveClip(options.actionClip, 'action', loaded)

        // If only 1 animation exists, toggle play/pause
        if (idleResolved === actionResolved || loaded.animations.length <= 1) {
          if (ecs.GltfModel.has(world, target)) {
            const current = ecs.GltfModel.get(world, target)
            ecs.GltfModel.mutate(world, target, (model) => {
              model.paused = !current.paused
              if (!model.animationClip) {
                model.animationClip = idleResolved
                model.loop = true
              }
            })
            nextClickAt = world.time.elapsed + Math.max(0, options.clickCooldown) * 1000
            return
          }
        }
      }

      const isAction = mode === 'action' && ecs.GltfModel.has(world, target) &&
        ecs.GltfModel.get(world, target).animationClip === playingClip
      const nextMode: AnimationMode = isAction ? 'idle' : 'action'

      if (play(nextMode)) {
        nextClickAt = world.time.elapsed + Math.max(0, options.clickCooldown) * 1000
      }
    }

    ecs.defineState('ready').initial()
      .onEnter(sync)
      .onTick(sync)
      .onExit(() => taps.clear())
      .listen(world.events.globalId, ecs.input.SCREEN_TOUCH_START, ({data}) => {
        taps.delete(data.pointerId)
        if (schemaAttribute.get(eid).enabled && hitsModel(data.target)) taps.add(data.pointerId)
      })
      .listen(world.events.globalId, ecs.input.SCREEN_TOUCH_MOVE, ({data}) => {
        const distance = Math.hypot(data.position.x - data.start.x, data.position.y - data.start.y)
        if (distance > maxTapMovement) taps.delete(data.pointerId)
      })
      .listen(world.events.globalId, ecs.input.GESTURE_START, ({data}) => {
        if (data.touchCount > 1) taps.clear()
      })
      .listen(world.events.globalId, ecs.input.SCREEN_TOUCH_END, ({data}) => {
        if (!taps.delete(data.pointerId)) return
        if (!hitsModel(data.target) && !hitsModel(data.endTarget)) return
        const distance = Math.hypot(data.position.x - data.start.x, data.position.y - data.start.y)
        if (distance <= maxTapMovement) toggle()
      })
      .listen(world.events.globalId, ecs.events.GLTF_ANIMATION_FINISHED, (event) => {
        const target = getTarget()
        if (event.target !== target || mode !== 'action' || event.data.name !== playingClip ||
            !ecs.GltfModel.has(world, target) ||
            ecs.GltfModel.get(world, target).animationClip !== playingClip) return
        actionFinished = true
        const options = schemaAttribute.get(eid)
        if (options.enabled && !options.loopAction && options.returnToIdle) play('idle')
      })
  },
})
