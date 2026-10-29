// Reviewed #60 scope: 25 screenshots for each of 12 rendering profiles.
const screens = Object.freeze(['board-long', 'table-long', 'calendar', 'my-tasks-long',
  'task-details', 'task-chat-offline-long', 'menu-theme', 'menu-user', 'board-archive', 'new-task-dialog-long']);
const states = Object.freeze(['board-loading', 'board-error', 'table-loading', 'table-error',
  'calendar-loading', 'calendar-error', 'chat-loading', 'chat-empty', 'chat-error',
  'my-tasks-loading', 'my-tasks-empty', 'my-tasks-error', 'board-empty', 'table-empty', 'calendar-empty']);
function requiredBaselinePaths() {
  return [360,768,1440].flatMap(width => ['light','dark','system-light','system-dark'].flatMap(theme => [
    ...screens.map(name => `visual-${width}-${theme}/design-screens.spec.cjs/${name}.png`),
    ...states.map(name => `visual-${width}-${theme}/design-states.spec.cjs/${name}.png`),
  ]));
}
module.exports = { screens, states, requiredBaselinePaths };
