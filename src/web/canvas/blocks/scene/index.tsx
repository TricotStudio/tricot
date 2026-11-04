// 3D scene blocks: a three.js scene, from its JSON, that people turn, zoom
// and pin spots on (scene.tsx). Agents write it; people add one with Add → 3D
// scene and edit its JSON, as they do a diagram's source. Open shows it full
// screen, to pair with an agent on its named objects (sceneView.tsx).

import { SCENE_EXAMPLE, editableSource } from '../../../../core/blocks/scene/scene';
import { useCanvas } from '../../context';
import type { ToolsProps, WebBlockKind } from '../kind';
import { SceneBody, editScene, type SceneBlock } from './scene';
import { SceneFullView } from './sceneView';

// Its menu: Open, its full view; and its JSON, to edit (as a double-click does).
function SceneTools({ block, viewing }: ToolsProps<SceneBlock>) {
  const canvas = useCanvas();
  return (
    <>
      <button onClick={() => canvas.openOverlay(block.id, { version: viewing ?? undefined })} title="Open it full screen, to look at it large or pair with an agent on its objects (Enter)">
        Open
      </button>
      {!viewing && ( // an earlier version is only for looking at
        <button onClick={() => editScene(block.id)} title="Edit the scene's three.js JSON (or double-click it)">
          Edit JSON
        </button>
      )}
    </>
  );
}

export const scene: WebBlockKind<SceneBlock> = {
  type: 'scene',
  Body: SceneBody,
  Tools: SceneTools,
  still: true, // the wheel pans the canvas over it until the block is selected; then it zooms the scene
  overlay: { Component: SceneFullView, refocus: true }, // its full view, in the pairing shell
  activate: (block, canvas) => canvas.openOverlay(block.id),
  menu: { label: '3D scene', add: () => ({ content: { type: 'scene', scene: editableSource(SCENE_EXAMPLE) }, title: 'New scene' }) },
};
