import * as ecs from '@8thwall/ecs'

ecs.registerComponent({
  name: 'Video Toggle Button',

  schema: {
    // @label Video Entity
    videoEntity: ecs.eid,

    // Image shown over the video while paused. Keep it as a child of the video.
    // @label Play Icon
    playIcon: ecs.eid,

    // Optional: when empty, use the nearest ancestor with an ImageTarget.
    // @label Image Target
    imageTarget: ecs.eid,

    // @label Play On Target Found
    playOnTargetFound: ecs.boolean,

    // @label Pause On Target Lost
    pauseOnTargetLost: ecs.boolean,
  },

  schemaDefaults: {
    playOnTargetFound: true,
    pauseOnTargetLost: true,
  },

  stateMachine: ({world, eid, schemaAttribute}) => {
    const belongsTo = (entity: bigint | undefined, ancestor: bigint) => {
      if (!ancestor) return false
      for (let current = entity; current; current = world.getParent(current)) {
        if (current === ancestor) return true
      }
      return false
    }

    const getVideo = () => {
      const {videoEntity} = schemaAttribute.get(eid)
      return videoEntity && ecs.VideoControls.has(world, videoEntity) ? videoEntity : 0n
    }

    const syncIcon = () => {
      const {playIcon} = schemaAttribute.get(eid)
      const video = getVideo()
      // A misassigned parent must never hide the video or the controller itself.
      if (!video || !playIcon || belongsTo(video, playIcon) || belongsTo(eid, playIcon)) return

      const paused = ecs.VideoControls.get(world, video).paused
      const hidden = ecs.Hidden.has(world, playIcon)
      if (paused && hidden) ecs.Hidden.remove(world, playIcon)
      if (!paused && !hidden) ecs.Hidden.set(world, playIcon)
    }

    const setPaused = (paused: boolean) => {
      const video = getVideo()
      if (!video) return

      if (!paused) {
        // The runtime does not replay an ended video until its time is reset.
        const object = world.three.entityToObject.get(video) as unknown as {
          material?: {map?: {image?: HTMLVideoElement}}
        }
        const media = object?.material?.map?.image
        if (media instanceof HTMLVideoElement && media.ended) media.currentTime = 0
      }

      if (ecs.VideoControls.get(world, video).paused !== paused) {
        ecs.VideoControls.mutate(world, video, (cursor) => {
          cursor.paused = paused
        })
      }
      syncIcon()
    }

    const toggle = () => {
      const video = getVideo()
      if (video) setPaused(!ecs.VideoControls.get(world, video).paused)
    }

    const isVideoArea = (target: bigint | undefined) => {
      const {videoEntity, playIcon} = schemaAttribute.get(eid)
      return target === eid || belongsTo(target, videoEntity) || belongsTo(target, playIcon)
    }

    const isUi = (target: bigint | undefined) => {
      for (let current = target; current; current = world.getParent(current)) {
        if (ecs.Ui.has(world, current)) return true
      }
      return false
    }

    const matchesTarget = (data: unknown) => {
      if (!data || typeof data !== 'object' || !('name' in data)) return false
      const {imageTarget} = schemaAttribute.get(eid)
      if (imageTarget) {
        return ecs.ImageTarget.has(world, imageTarget) &&
          ecs.ImageTarget.get(world, imageTarget).name === data.name
      }

      for (let current = eid; current; current = world.getParent(current)) {
        if (ecs.ImageTarget.has(world, current)) {
          return ecs.ImageTarget.get(world, current).name === data.name
        }
      }
      return false
    }

    ecs.defineState('ready')
      .initial()
      .onEnter(syncIcon)
      // Reflect changes made by other components or the Inspector as well.
      .onTick(syncIcon)
      .listen(world.events.globalId, ecs.input.SCREEN_TOUCH_END, ({data}) => {
        // UI emits its own click. Do not toggle twice for the same gesture.
        if (isUi(data.target) || !isVideoArea(data.target) || !isVideoArea(data.endTarget)) return
        const movement = Math.hypot(data.position.x - data.start.x, data.position.y - data.start.y)
        if (movement <= 0.025) toggle()
      })
      .listen(world.events.globalId, ecs.input.UI_CLICK, (event) => {
        if (isVideoArea(event.target)) toggle()
      })
      .listen(world.events.globalId, ecs.events.REALITY_IMAGE_FOUND, ({data}) => {
        if (matchesTarget(data) && schemaAttribute.get(eid).playOnTargetFound) setPaused(false)
      })
      .listen(world.events.globalId, ecs.events.REALITY_IMAGE_LOST, ({data}) => {
        if (matchesTarget(data) && schemaAttribute.get(eid).pauseOnTargetLost) setPaused(true)
      })
      .listen(world.events.globalId, ecs.events.VIDEO_END, (event) => {
        if (event.target === getVideo()) setPaused(true)
      })
      .listen(world.events.globalId, 'video-error', (event) => {
        // A cancelled play request is expected if the target is lost immediately.
        if (event.target === getVideo() && event.data.error?.name !== 'AbortError') {
          setPaused(true)
          console.warn('Video playback failed. Tap the play icon to retry.', event.data.error)
        }
      })
  },
})
