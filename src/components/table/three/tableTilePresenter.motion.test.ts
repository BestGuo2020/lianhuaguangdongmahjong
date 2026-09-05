import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { createTableTilePresenter } from './tableTilePresenter'
import type { TileInstanceRenderer } from './tileInstanceRenderer'
import type { ResolvedTableProps } from './tableRenderTypes'
import type { GamePlayer, Meld, TableActionType, TileType } from '../../../game/core/contracts/types'

function setup(meld?: Meld, action?: TableActionType) {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const scene = new THREE.Scene()
  scene.userData.tileImages = {}
  scene.userData.highlightMaterial = new THREE.MeshBasicMaterial()
  const rendered: { face: TileType | null; position: THREE.Vector3; scale: number }[] = []
  const instances = {
    begin: () => { rendered.length = 0 }, finish: () => {}, canReuse: () => false,
    add: (position: THREE.Vector3, _q: THREE.Quaternion, face: TileType | null, _opacity = 1, origin = position, scale = 1) => {
      const index = rendered.length
      rendered.push({ face, position: origin.clone(), scale })
      return { baseIndex: index, capIndex: index, capMesh: {} }
    },
    set: (index: number, _mesh: unknown, _cap: number, position: THREE.Vector3, _q: THREE.Quaternion, scale: number) => {
      rendered[index].position.copy(position); rendered[index].scale = scale
    },
  } as unknown as TileInstanceRenderer
  const players: GamePlayer[] = [0, 1, 2, 3].map(seat => ({ seat, name: `${seat}`, avatar: '', score: 2000,
    hand: [], discards: [], melds: seat === 0 && meld ? [meld] : [], redCount: 0, drawnTileIndex: -1 }))
  const props = { players, localSeat: 0, currentPlayer: 0, wall: [], wallHeadDrawn: 0, wallCount: 0,
    horses: [], jokerTiles: [], wildcardTiles: [], revealHands: false, winnerIndex: -1,
    winEffect: null, winPresentation: null, dealAnimation: { playerIndex: -1, count: 0, serial: 0 },
    openingStage: null, diceValues: [1, 2], dealerIndex: 0, diceThrowerIndex: 0, flipStack: null,
    flipTile: null, wallBreakIndex: 0, lastDiscard: null,
    tableActionEvent: action ? { id: 1, type: action, actorIndex: 0, sourceIndex: 1, tile: 'm5', meldIndex: 0 } : null,
  } as unknown as ResolvedTableProps
  const dynamicGroups: THREE.Object3D[] = []
  const presenter = createTableTilePresenter({ props, scene, dynamicGroups, ownDynamic: value => value,
    clearDynamicScene: () => { dynamicGroups.splice(0).forEach(g => g.removeFromParent()) },
    makeFaceTile: () => new THREE.Group(), tableScene: { makeDimmedHorseTile: () => new THREE.Group(),
      makeGoldGlow: () => new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial()), makeGoldVerticalGlow: () => new THREE.Sprite() },
    tileInstances: instances, tileLayerZ: -1, playAreaOffsetZ: -1.65, tileGapOffset: .685,
    pointGapOffset: .965, wallDealOriginY: 1,
    addWinEffect: () => {}, addWinningDisplayTile: () => {},
  })
  return { props, rendered, presenter, setNow: (t: number) => { now = t } }
}

afterEach(() => vi.restoreAllMocks())

describe('shared normal tile animations survive state refreshes', () => {
  it('does not carry an unfinished discard into a restored blood-flow view', () => {
    const s = setup()
    s.props.bloodFlowPresentationKey = 'live'
    s.props.players[0].discards = ['m5']
    s.props.lastDiscard = { id: 7, from: 0, tile: 'm5' }
    s.presenter.rebuild()
    s.setNow(100); s.presenter.animate(100, new THREE.Vector3())
    s.props.bloodFlowPresentationKey = 'restored'
    s.presenter.rebuild()
    expect(s.presenter.animate(100, new THREE.Vector3())).toBe(false)
  })

  it('continues a deal tween without restarting it on every refresh', () => {
    const s = setup()
    s.props.players[1].hand = ['m3']
    s.props.players[1].concealedTileCount = 1
    s.props.dealAnimation = { playerIndex: 1, count: 1, serial: 1 }
    s.presenter.rebuild()
    s.setNow(50); s.presenter.animate(50, new THREE.Vector3())
    const before = s.rendered[0].position.clone()
    s.presenter.rebuild()
    expect(s.rendered[0].position.distanceTo(before)).toBeLessThan(.00001)
    expect(s.presenter.animate(100, new THREE.Vector3())).toBe(true)
    expect(s.presenter.animate(150, new THREE.Vector3())).toBe(false)
    s.setNow(200); s.presenter.rebuild()
    expect(s.presenter.animate(200, new THREE.Vector3())).toBe(false)
  })

  it('continues the existing flip motion without replaying a finished flip', () => {
    const s = setup()
    s.props.flipStack = 0; s.props.flipTile = 'p9'; s.props.openingStage = 'flip'
    s.props.wall = ['east']; s.props.wallCount = 1
    s.presenter.rebuild()
    s.setNow(100); s.presenter.animate(100, new THREE.Vector3())
    const before = s.rendered.find(r => r.face === 'p9')!.position.y
    s.presenter.rebuild()
    expect(s.rendered.find(r => r.face === 'p9')!.position.y).toBe(before)
    expect(s.presenter.animate(300, new THREE.Vector3())).toBe(true)
    expect(s.presenter.animate(600, new THREE.Vector3())).toBe(false)
    s.setNow(700); s.presenter.rebuild()
    expect(s.presenter.animate(700, new THREE.Vector3())).toBe(false)
  })

  it('continues the original discard arc after an identical snapshot rebuild', () => {
    const s = setup()
    s.props.players[0].discards = ['m5']
    s.props.lastDiscard = { id: 7, from: 0, tile: 'm5' }
    s.presenter.rebuild()
    s.setNow(100); expect(s.presenter.animate(100, new THREE.Vector3())).toBe(true)
    const before = s.rendered[0].position.clone()
    s.props.players = structuredClone(s.props.players)
    s.presenter.rebuild()
    expect(s.rendered[0].position.distanceTo(before)).toBeLessThan(.00001)
    expect(s.presenter.animate(200, new THREE.Vector3())).toBe(true)
    expect(s.presenter.animate(400, new THREE.Vector3())).toBe(false)
    s.setNow(500); s.presenter.rebuild()
    expect(s.presenter.animate(500, new THREE.Vector3())).toBe(false)
  })

  it.each([
    ['chi', { type: 'chi', tile: 'm5', from: 1, tiles: ['m4', 'm5', 'm6'] }],
    ['peng', { type: 'peng', tile: 'm5', from: 1, tiles: ['m5', 'm5', 'm5'] }],
    ['discard-gang', { type: 'gang', tile: 'm5', from: 1, tiles: ['m5', 'm5', 'm5', 'm5'] }],
    ['concealed-gang', { type: 'angang', tile: 'm5', tiles: ['m5', 'm5', 'm5', 'm5'] }],
    ['added-gang', { type: 'gang', tile: 'm5', from: 1, added: true, tiles: ['m5', 'm5', 'm5', 'm5'] }],
  ] as [TableActionType, Meld][])('keeps %s landing in progress when unrelated props rebuild the table', (action, meld) => {
    const s = setup(meld, action)
    s.presenter.rebuild()
    s.setNow(100); expect(s.presenter.animate(100, new THREE.Vector3())).toBe(true)
    const before = s.rendered.map(r => ({ y: r.position.y, scale: r.scale }))
    s.props.players = structuredClone(s.props.players)
    s.presenter.rebuild()
    expect(s.rendered.map(r => ({ y: r.position.y, scale: r.scale }))).toEqual(before)
    expect(s.presenter.animate(200, new THREE.Vector3())).toBe(true)
    expect(s.presenter.animate(500, new THREE.Vector3())).toBe(false)
    s.setNow(600); s.presenter.rebuild()
    expect(s.presenter.animate(600, new THREE.Vector3())).toBe(false)
  })
})
