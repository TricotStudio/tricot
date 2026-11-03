// 3D scene blocks: a three.js scene, from its JSON, that people turn, zoom
// and pin spots on (scene.tsx). Agents write it; people add one with Add → 3D
// scene and edit its JSON, as they do a diagram's source.

import { SCENE_EXAMPLE, editableSource } from '../../../../core/blocks/scene/scene';
import type { ToolsProps, WebBlockKind } from '../kind';
import { SceneBody, editScene, type SceneBlock } from './scene';

// Its menu: its JSON, to edit (as a double-click does).
function SceneTools({ block, viewing }: ToolsProps<SceneBlock>) {
  if (viewing) return null; // an earlier version is only for looking at
  return (
    <button onClick={() => editScene(block.id)} title="Edit the scene's three.js JSON (or double-click it)">
      Edit JSON
    </button>
  );
}

export const scene: WebBlockKind<SceneBlock> = {
  type: 'scene',
  Body: SceneBody,
  Tools: SceneTools,
  still: true, // the wheel pans the canvas over it until the block is selected; then it zooms the scene
  menu: { label: '3D scene', add: () => ({ content: { type: 'scene', scene: editableSource(SCENE_EXAMPLE) }, title: 'New scene' }) },
};
