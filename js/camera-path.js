/**
 * Mounts the camera path editor on the CameraPath_Video node and feeds it the point
 * cloud the backend cached on its last run.
 *
 * Renderer notes (both LiteGraph and Nodes 2.0 must work):
 * - The editor is a DOM widget (`addDOMWidget`), which the Vue renderer wraps in
 *   WidgetDOM. Nothing here draws on the node canvas.
 * - Node instances are destroyed and rebuilt on workflow tab switches and subgraph
 *   navigation, so the preview payload lives in a module-level Map keyed by node id
 *   and is replayed into whatever editor instance exists now.
 * - `node.id` is a string in frontend 1.46+; always key maps with `String(node.id)`.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { createCameraEditor } from "./editor.js";

const NODE_TYPE = "CameraPath_Video";

/** Smallest the editor stays usable at; above this it follows the node's height. */
const MIN_EDITOR_HEIGHT = 520;
const MIN_EDITOR_WIDTH = 360;

/**
 * Row heights the reserve below is built from. Tuned against the rendered node
 * rather than taken from LiteGraph's nominal constants, which the Vue renderer
 * does not follow exactly.
 */
const SLOT_HEIGHT = 18;
const WIDGET_ROW_HEIGHT = 20;

/**
 * Height the node spends on everything that is not the editor.
 *
 * Kept a touch generous on purpose. The editor claims whatever is left over, so
 * under-estimating would have it ask for more than the node has; the node would grow
 * to fit, the next pass would ask for more again, and the node would run away. A few
 * pixels of dead space is the safe side of that trade.
 * @param {object} node The node being measured.
 * @param {object} editorWidget The editor's own widget, excluded from the total.
 * @returns {number} Pixels reserved for the slots and the other widgets.
 */
function chromeHeight(node, editorWidget) {
  const slots = Math.max(node.inputs?.length ?? 0, node.outputs?.length ?? 0);
  const widgets = (node.widgets ?? [])
    .filter((widget) => widget !== editorWidget && widget.type !== "hidden" && !widget.hidden).length;
  return slots * SLOT_HEIGHT + widgets * WIDGET_ROW_HEIGHT;
}

/** Last editor payload per node id, so a rebuilt node keeps its cached cloud. @type {Map<string, object>} */
const lastPayload = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Builds a /view URL for a file reference in the node's UI payload.
 * @param {{filename: string, subfolder?: string, type?: string}} reference
 * @returns {string} URL the editor can load the PNG from.
 */
function viewUrl(reference) {
  const query = new URLSearchParams({
    filename: reference.filename,
    subfolder: reference.subfolder || "",
    type: reference.type || "temp",
  });
  return api.apiURL(`/view?${query}`);
}

/**
 * Pushes a stored payload into an editor: the path it rendered plus the cached cloud.
 * @param {object} editor Editor handle from createCameraEditor().
 * @param {object} payload Parsed `camera_path` UI output.
 * @returns {void}
 */
function applyPayload(editor, payload) {
  editor.setInputPath(payload.input_path ?? null);
  editor.setPreview(payload.preview, viewUrl);
}

/**
 * Removes a widget from the node body while keeping its value in the workflow.
 *
 * The editor owns the keyframe JSON, so its widget is dead weight on screen -- and a
 * growable one, which competed with the editor for the node's spare height. The two
 * renderers hide widgets differently, hence both paths.
 * @param {object} widget Widget to collapse.
 * @returns {void}
 */
function hideWidget(widget) {
  widget.hidden = true;
  widget.type = "hidden";
  widget.computeSize = () => [0, -4];
  widget.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 });
}

// ── Extension ──────────────────────────────────────────────────────────────

app.registerExtension({
  name: "phazei.CameraPath",

  /**
   * Chains onExecuted so the node receives its own UI output. There is no
   * extension-level hook for per-node execution results.
   * @param {object} nodeType LGraphNode subclass being registered.
   * @param {object} nodeData Node definition from /object_info.
   * @returns {void}
   */
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const result = onExecuted?.apply(this, arguments);
      const raw = message?.camera_path?.[0];
      if (!raw) return result;
      try {
        const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
        lastPayload.set(String(this.id), payload);
        if (this.cameraPathEditor) applyPayload(this.cameraPathEditor, payload);
      } catch (problem) {
        console.warn("[CameraPath] could not read the editor payload", problem);
      }
      return result;
    };
  },

  /**
   * Creates the editor widget. Fires inside the LGraphNode constructor, so
   * `node.graph` is not set yet -- do not touch it here.
   * @param {object} node The freshly constructed node.
   * @returns {void}
   */
  nodeCreated(node) {
    if (node.comfyClass !== NODE_TYPE) return;
    const find = (name) => node.widgets?.find((widget) => widget.name === name);
    const pathWidget = find("keyframes");
    if (!pathWidget) return;
    hideWidget(pathWidget);

    const editor = createCameraEditor({
      readPath: () => pathWidget.value,
      writePath: (value) => {
        pathWidget.value = value;
        pathWidget.callback?.(value);
        // No-op under Nodes 2.0, which repaints from Vue reactivity instead.
        node.setDirtyCanvas(true, true);
      },
      readFrameCount: () => Number(find("frame_count")?.value) || 1,
      readFps: () => Number(find("fps")?.value) || 24,
      readMarkers: () => Boolean(find("markers")?.value),
    });
    node.cameraPathEditor = editor;

    // A DOM widget is laid out at its minimum height and is never handed the node's
    // spare space, so leaving maxHeight unbounded is not enough: the minimum itself
    // has to track the node, or dragging the node taller just opens a gap below the
    // editor. Reading node.size live means shrinking follows too.
    let claimed = MIN_EDITOR_HEIGHT;
    const claim = () => {
      claimed = Math.max(MIN_EDITOR_HEIGHT, (node.size?.[1] ?? 0) - chromeHeight(node, widget));
      return claimed;
    };

    const widget = node.addDOMWidget("camera_path_editor", "CAMERA_PATH_EDITOR", editor.element, {
      serialize: false,
      // The honest floor. Claiming the node's height here too would make the layout's
      // minimum follow the node up and the node could never be dragged back down.
      getMinHeight: () => MIN_EDITOR_HEIGHT,
    });
    // This is what the rendered height is taken from, so it has to be the live claim --
    // a fixed floor here pins the editor and reopens the gap beneath it.
    widget.computeSize = () => [MIN_EDITOR_WIDTH, claim()];

    // ...but LiteGraph also sums widget.computeSize() to get the node's minimum height,
    // and that sum now contains the claim, which equals the node's current height. Left
    // alone the node ratchets: every height it reaches becomes a height it cannot leave.
    // Discounting the claim back to the floor keeps the minimum where it belongs.
    const nodeComputeSize = node.computeSize;
    node.computeSize = function () {
      const size = nodeComputeSize.apply(this, arguments);
      size[1] -= Math.max(0, claimed - MIN_EDITOR_HEIGHT);
      return size;
    };

    for (const name of ["keyframes", "frame_count", "fps", "markers"]) {
      const target = find(name);
      if (!target) continue;
      const callback = target.callback;
      target.callback = function () {
        const value = callback?.apply(this, arguments);
        editor.sync();
        return value;
      };
    }

    const onConfigure = node.onConfigure;
    node.onConfigure = function () {
      const value = onConfigure?.apply(this, arguments);
      editor.sync();
      // The id is only final once the graph has configured the node.
      const payload = lastPayload.get(String(node.id));
      if (payload) applyPayload(editor, payload);
      return value;
    };

    const onRemoved = node.onRemoved;
    node.onRemoved = function () {
      editor.destroy();
      return onRemoved?.apply(this, arguments);
    };

    node.setSize([Math.max(node.size[0], 460), Math.max(node.size[1], 860)]);
  },

  /**
   * Nodes are rebuilt from scratch on tab switches and subgraph navigation.
   * Replay the cached cloud into the new editor instances.
   * @returns {void}
   */
  afterConfigureGraph() {
    if (!lastPayload.size) return;
    for (const node of app.graph?.nodes ?? []) {
      if (node.comfyClass !== NODE_TYPE || !node.cameraPathEditor) continue;
      const payload = lastPayload.get(String(node.id));
      if (payload) applyPayload(node.cameraPathEditor, payload);
    }
  },
});
