import {
  TABLE_THEME_NAMES,
  tableThemeIdentity,
  type TableThemeName,
} from './themeIdentity'

export type ThemeParticle = 'none' | 'dust' | 'stars' | 'confetti' | 'theme-art'
export type ThemePlayerFrame = 'jade' | 'playful' | 'wood' | 'cosmic' | 'anime'

export interface ThemePresentation {
  identity: {
    label: string
    description: string
    previewUrl: string
    colorScheme: 'dark' | 'light'
  }
  shell: {
    pageBackground: string
    ambientOverlay: string
    motif: string
    particle: ThemeParticle
  }
  palette: {
    surface: string
    panel: string
    panelElevated: string
    text: string
    textMuted: string
    border: string
    accent: string
    accentSecondary: string
    positive: string
    negative: string
  }
  typography: {
    headingClass: string
    numberClass: string
    actionClass: string
  }
  hud: {
    playerFrame: ThemePlayerFrame
    topBar: string
    button: string
    tooltip: string
  }
  presentation: {
    loading: string
    opening: string
    action: string
    win: string
    settlement: string
    error: string
  }
  motion: {
    ambient: string
    activeSeat: string
    actionEnter: string
    scoreChange: string
  }
}

export function resolveThemeAssetUrl(path: string, baseUrl = import.meta.env.BASE_URL): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${normalizedBase}${path.replace(/^\/+/, '')}`
}

function identity(name: TableThemeName, colorScheme: 'dark' | 'light'): ThemePresentation['identity'] {
  const { label, description } = tableThemeIdentity(name)
  return {
    label,
    description,
    previewUrl: resolveThemeAssetUrl(`themes/previews/v1/${name}.svg`),
    colorScheme,
  }
}

export const THEME_PRESENTATIONS = {
  jade: {
    identity: identity('jade', 'dark'),
    shell: {
      pageBackground: 'radial-gradient(circle at 50% 42%, rgba(35, 101, 72, .30), transparent 43%), repeating-linear-gradient(87deg, rgba(255,255,255,.012) 0 1px, transparent 1px 7px), #07110d',
      ambientOverlay: 'radial-gradient(circle at 50% 25%, rgba(126, 169, 139, .10), transparent 38%)',
      motif: 'faceted-jade',
      particle: 'dust',
    },
    palette: {
      surface: '#163a2c', panel: '#0a231a', panelElevated: '#123327', text: '#f8f3df',
      textMuted: '#aebdb1', border: '#b99249', accent: '#dfbd68', accentSecondary: '#79a487',
      positive: '#78c996', negative: '#e98378',
    },
    typography: { headingClass: 'theme-heading-serif', numberClass: 'theme-number-classic', actionClass: 'theme-action-seal' },
    hud: {
      playerFrame: 'jade',
      topBar: 'linear-gradient(180deg, rgba(4,14,10,.92), rgba(4,19,14,.56), transparent)',
      button: 'linear-gradient(180deg, rgba(31,71,54,.94), rgba(9,31,23,.96))',
      tooltip: 'linear-gradient(155deg, rgba(18,48,36,.98), rgba(5,19,14,.99) 70%)',
    },
    presentation: {
      loading: 'jade-facet', opening: 'jade-signet', action: 'jade-cut', win: 'jade-radiance',
      settlement: 'jade-ledger', error: 'jade-alert',
    },
    motion: { ambient: 'jade-glint', activeSeat: 'jade-flow', actionEnter: 'cut-in', scoreChange: 'lift-fade' },
  },
  happyMahjong: {
    identity: identity('happyMahjong', 'dark'),
    shell: {
      pageBackground: 'radial-gradient(circle at 28% 18%, rgba(255,203,83,.20), transparent 30%), radial-gradient(circle at 76% 74%, rgba(239,118,87,.16), transparent 34%), linear-gradient(145deg, #0b3540, #071d26 68%, #06151b)',
      ambientOverlay: 'repeating-linear-gradient(135deg, rgba(255,255,255,.025) 0 2px, transparent 2px 18px)',
      motif: 'rounded-confetti',
      particle: 'confetti',
    },
    palette: {
      surface: '#175566', panel: '#0e3b48', panelElevated: '#185c6c', text: '#fff9e8',
      textMuted: '#b9d8d6', border: '#efc85b', accent: '#f7ca4e', accentSecondary: '#f07a5d',
      positive: '#7bd6a3', negative: '#ff8478',
    },
    typography: { headingClass: 'theme-heading-rounded', numberClass: 'theme-number-rounded', actionClass: 'theme-action-pop' },
    hud: {
      playerFrame: 'playful',
      topBar: 'linear-gradient(180deg, rgba(6,40,49,.94), rgba(7,47,57,.62), transparent)',
      button: 'linear-gradient(180deg, #f8d35e, #e9a83f)',
      tooltip: 'linear-gradient(155deg, rgba(20,82,95,.98), rgba(7,36,45,.99) 72%)',
    },
    presentation: {
      loading: 'happy-orbit', opening: 'happy-burst', action: 'happy-pop', win: 'happy-confetti',
      settlement: 'happy-podium', error: 'happy-alert',
    },
    motion: { ambient: 'happy-drift', activeSeat: 'happy-pulse', actionEnter: 'pop-in', scoreChange: 'bounce-fade' },
  },
  rosewood: {
    identity: identity('rosewood', 'dark'),
    shell: {
      pageBackground: 'radial-gradient(circle at 50% 34%, rgba(173,86,53,.24), transparent 42%), repeating-linear-gradient(92deg, rgba(255,218,164,.018) 0 1px, transparent 1px 9px), #1a0906',
      ambientOverlay: 'linear-gradient(115deg, transparent 20%, rgba(230,178,102,.055) 48%, transparent 72%)',
      motif: 'lacquer-grain',
      particle: 'dust',
    },
    palette: {
      surface: '#542417', panel: '#2b120c', panelElevated: '#4a2015', text: '#fff3dc',
      textMuted: '#d0bba3', border: '#c99a4c', accent: '#e0b45c', accentSecondary: '#b7523f',
      positive: '#82bf8d', negative: '#e67465',
    },
    typography: { headingClass: 'theme-heading-serif', numberClass: 'theme-number-ledger', actionClass: 'theme-action-paper' },
    hud: {
      playerFrame: 'wood',
      topBar: 'linear-gradient(180deg, rgba(30,10,6,.94), rgba(57,22,13,.60), transparent)',
      button: 'linear-gradient(180deg, #74402b, #3d1c12)',
      tooltip: 'linear-gradient(155deg, rgba(75,31,20,.98), rgba(32,12,8,.99) 72%)',
    },
    presentation: {
      loading: 'wood-lantern', opening: 'wood-ledger', action: 'wood-stamp', win: 'wood-radiance',
      settlement: 'wood-score-sheet', error: 'wood-alert',
    },
    motion: { ambient: 'wood-sheen', activeSeat: 'warm-glow', actionEnter: 'paper-cut', scoreChange: 'ink-rise' },
  },
  llm: {
    identity: identity('llm', 'dark'),
    shell: {
      pageBackground: 'radial-gradient(circle at 50% 32%, rgba(72,111,222,.26), transparent 38%), radial-gradient(circle at 82% 72%, rgba(116,82,203,.14), transparent 28%), #03081b',
      ambientOverlay: 'repeating-linear-gradient(90deg, rgba(118,217,255,.025) 0 1px, transparent 1px 32px)',
      motif: 'data-orbit',
      particle: 'stars',
    },
    palette: {
      surface: '#101d43', panel: '#081431', panelElevated: '#102451', text: '#eef4ff',
      textMuted: '#aebce2', border: '#76d9ff', accent: '#76d9ff', accentSecondary: '#9a8af0',
      positive: '#65d5b1', negative: '#ff7f93',
    },
    typography: { headingClass: 'theme-heading-tech', numberClass: 'theme-number-mono', actionClass: 'theme-action-scan' },
    hud: {
      playerFrame: 'cosmic',
      topBar: 'linear-gradient(180deg, rgba(3,8,27,.96), rgba(8,20,54,.64), transparent)',
      button: 'linear-gradient(180deg, rgba(28,61,130,.96), rgba(8,24,62,.98))',
      tooltip: 'linear-gradient(155deg, rgba(17,38,88,.98), rgba(5,14,42,.99) 72%)',
    },
    presentation: {
      loading: 'llm-scan', opening: 'llm-boot', action: 'llm-pulse', win: 'llm-supernova',
      settlement: 'llm-report', error: 'llm-alert',
    },
    motion: { ambient: 'star-drift', activeSeat: 'data-pulse', actionEnter: 'scan-in', scoreChange: 'counter-rise' },
  },
  llmAnime: {
    identity: identity('llmAnime', 'dark'),
    shell: {
      pageBackground: 'radial-gradient(circle at 28% 20%, rgba(120,216,232,.12), transparent 28%), radial-gradient(circle at 75% 70%, rgba(189,91,72,.16), transparent 34%), #0a120f',
      ambientOverlay: 'linear-gradient(125deg, transparent 12%, rgba(244,237,223,.025) 48%, transparent 74%)',
      motif: 'comic-panels',
      particle: 'theme-art',
    },
    palette: {
      surface: '#29372f', panel: '#18231e', panelElevated: '#29372f', text: '#fff8ec',
      textMuted: '#c8c4b9', border: '#9d9282', accent: '#bd5b48', accentSecondary: '#78d8e8',
      positive: '#70bf89', negative: '#ed786a',
    },
    typography: { headingClass: 'theme-heading-comic', numberClass: 'theme-number-comic', actionClass: 'theme-action-comic' },
    hud: {
      playerFrame: 'anime',
      topBar: 'linear-gradient(180deg, rgba(8,14,11,.96), rgba(20,31,26,.66), transparent)',
      button: 'linear-gradient(180deg, #bd5b48, #9f4035)',
      tooltip: 'linear-gradient(155deg, rgba(36,48,41,.98), rgba(12,20,16,.99) 72%)',
    },
    presentation: {
      loading: 'anime-panel', opening: 'anime-title-card', action: 'anime-cut-in', win: 'anime-finale',
      settlement: 'anime-storyboard', error: 'anime-alert',
    },
    motion: { ambient: 'panel-drift', activeSeat: 'ink-pulse', actionEnter: 'comic-swipe', scoreChange: 'caption-rise' },
  },
} satisfies Record<TableThemeName, ThemePresentation>

export type ThemePresentationCssVariables = Record<`--theme-${string}`, string>

export function themePresentationByName(name: string | null | undefined): ThemePresentation {
  return name && TABLE_THEME_NAMES.includes(name as TableThemeName)
    ? THEME_PRESENTATIONS[name as TableThemeName]
    : THEME_PRESENTATIONS.jade
}

export function themePresentationCssVariables(theme: ThemePresentation): ThemePresentationCssVariables {
  return {
    '--theme-page-background': theme.shell.pageBackground,
    '--theme-ambient-overlay': theme.shell.ambientOverlay,
    '--theme-surface': theme.palette.surface,
    '--theme-panel': theme.palette.panel,
    '--theme-panel-elevated': theme.palette.panelElevated,
    '--theme-text': theme.palette.text,
    '--theme-text-muted': theme.palette.textMuted,
    '--theme-border': theme.palette.border,
    '--theme-accent': theme.palette.accent,
    '--theme-accent-secondary': theme.palette.accentSecondary,
    '--theme-positive': theme.palette.positive,
    '--theme-negative': theme.palette.negative,
    '--theme-top-bar': theme.hud.topBar,
    '--theme-button': theme.hud.button,
    '--theme-tooltip': theme.hud.tooltip,
  }
}
