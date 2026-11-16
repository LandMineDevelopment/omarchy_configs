import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui

BarWidget {
  id: root
  moduleName: "kasey.codex-weekly"
  property var record: null
  property double now: Date.now()
  readonly property var weekly: {
    var limits = record && Array.isArray(record.limits) ? record.limits : []
    for (var i = 0; i < limits.length; i++) {
      var limit = limits[i]
      if (/weekly|7.day/i.test(String(limit.label)) && typeof limit.percent === "number"
          && isFinite(limit.percent) && limit.percent >= 0) return limit
    }
    return null
  }
  readonly property bool expired: weekly && isFinite(Date.parse(weekly.resetsAt)) && Date.parse(weekly.resetsAt) <= now
  readonly property bool stale: record && (!isFinite(Date.parse(record.updatedAt)) || now - Date.parse(record.updatedAt) > 1800000)
  readonly property string usage: weekly && !expired ? Math.round(weekly.percent * 100) + "% used" : "unavailable"
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  FileView {
    id: usageFile
    path: (Quickshell.env("XDG_STATE_HOME") || Quickshell.env("HOME") + "/.local/state") + "/omarchy/agents/usage/codex.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try { root.record = JSON.parse(text()) }
      catch (e) { root.record = null }
    }
    onLoadFailed: root.record = null
  }

  // The user timer refreshes the data independently of shell rendering.
  SystemClock {
    precision: SystemClock.Minutes
    onDateChanged: root.now = date.getTime()
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "Codex week: " + root.usage + (root.stale && root.weekly && !root.expired ? " · stale" : "")
    active: root.weekly !== null && !root.expired && root.weekly.percent >= 0.9
    tooltipText: "Codex weekly allowance"
      + (root.weekly && !root.expired ? "\nResets " + new Date(root.weekly.resetsAt).toLocaleString() : "\nWaiting for current weekly usage")
      + (root.stale ? "\nUsage data is over 30 minutes old" : "")
      + (root.record && root.record.usageStatusText ? "\n" + root.record.usageStatusText : "")
      + "\nClick to open agent usage"
    onPressed: Quickshell.execDetached(["omarchy-shell", "omarchy.agents", "toggle"])
  }
}
