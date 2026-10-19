import * as ecs from '@8thwall/ecs'

ecs.registerComponent({
  name: 'Open URL UI Button',

  schema: {
    // @label Enabled
    enabled: ecs.boolean,
    // @label URL
    url: ecs.string,
    // @label Open In New Tab
    openInNewTab: ecs.boolean,
  },

  schemaDefaults: {
    enabled: true,
    url: 'https://example.com',
    openInNewTab: true,
  },

  stateMachine: ({eid, schemaAttribute}) => {
    ecs.defineState('ready')
      .initial()
      .listen(eid, ecs.input.UI_CLICK, () => {
        const {enabled, url, openInNewTab} = schemaAttribute.get(eid)
        const cleanUrl = url.trim()
        if (!enabled || !cleanUrl) return

        let destination: URL
        try {
          destination = new URL(cleanUrl)
          if (destination.protocol !== 'https:' && destination.protocol !== 'http:') {
            throw new Error('Unsupported protocol')
          }
        } catch {
          console.warn('Open URL UI Button: enter a valid URL starting with https:// or http://.')
          return
        }

        if (openInNewTab) window.open(destination.href, '_blank', 'noopener,noreferrer')
        else window.location.assign(destination.href)
      })
  },
})
