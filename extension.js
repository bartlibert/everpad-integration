const St = imports.gi.St;
const Main = imports.ui.main;
const Lang = imports.lang;
const Shell = imports.gi.Shell;
const Mainloop = imports.mainloop;
const Clutter = imports.gi.Clutter;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Animation = imports.ui.animation;
const Meta = imports.gi.Meta;
const ExtensionUtils = imports.misc.extensionUtils;

const Me = ExtensionUtils.getCurrentExtension();
const Utils = Me.imports.utils;
const Everpad = Me.imports.everpad;
const EverpadMenu = Me.imports.menu;
const EverpadSyncStatus = Me.imports.sync_status;
const EverpadProgressBar = Me.imports.progress_bar;
const DBus = Me.imports.dbus;
const PrefsKeys = Me.imports.prefs_keys;

const SYNC_STATES = Me.imports.constants.SYNC_STATES;
const SYNC_STATES_TEXT = Me.imports.constants.SYNC_STATES_TEXT;
const SHOW_MENU_DELAY = 300;

const ICON_NAMES = Me.imports.constants.ICON_NAMES;

const SIGNAL_IDS = {
    sync_state: 0,
    owner_changed: 0,
    data_changed: 0
};

function show_button() {
    if(Main.sessionMode.currentMode !== 'user') return;

    if(everpad_button === null) {
        everpad_button = new EverpadPanelButton();

        Everpad.TRIGGERS.refresh_latest = true;
        Everpad.TRIGGERS.refresh_pinned = true;
    }
}

function hide_button() {
    if(everpad_button !== null) {
        everpad_button.destroy();
        everpad_button = null;
    }
}

function check_dbus(callback) {
    DBus.get_dbus_control().ListNamesRemote(
        Lang.bind(this, function(result, error) {
            if(result !== null) {
                let found = false;

                for(let i = 0; i < result[0].length; i++) {
                    if(result[0][i] == 'com.everpad.App') {
                        found = true;
                        break;
                    }
                }

                callback(found);
            }
            else {
                callback(false)
                log(error);
            }
        })
    );
}

const EverpadPanelButton = Lang.Class({
    Name: 'EverpadPanelButton',
    Extends: PanelMenu.Button,

    _init: function() {
        this.parent(0.0, 'everpad', false);
        this.actor.reactive = false;
        Main.panel.addToStatusArea('everpad', this);

        this._label = new St.Label({
            text: 'E',
            style_class: 'everpad-panel-button',
            reactive: true,
            track_hover: true
        });
        this._button_box = new St.BoxLayout({
            reactive: true,
            track_hover: true
        });
        this._button_box.connect('button-press-event', Lang.bind(this,
            this._on_button_press
        ));
        this._button_box.connect("enter-event", Lang.bind(this, function() {
            this._label.remove_style_pseudo_class("updated");
            this._button_box.timeout_id = Mainloop.timeout_add(SHOW_MENU_DELAY,
                Lang.bind(this, function() {
                    this._sync_status.check_status();
                    this._menu.show();
                    this._panel_progress_bar.hide()
                })
            );
        }));
        this._button_box.connect("leave-event", Lang.bind(this, function() {
            if(this._button_box.timeout_id > 0) {
                Mainloop.source_remove(this._button_box.timeout_id);

                if(this._syncing_in_progress) {
                    this._panel_progress_bar.show()
                }
            }
        }));
        this._button_box.add(this._label);
        this.actor.add_actor(this._button_box);

        this._menu = new EverpadMenu.EverpadMenu(this.actor);
        this._menu.set_logo(new St.Label({
            text: "Everpad",
            style_class: 'everpad-logo-label'
        }));
        this._add_menu_items();

        this._everpad = new Everpad.Everpad();
        this._sync_status = new EverpadSyncStatus.EverpadSyncStatus();
        this._menu.add_actor(this._sync_status.actor);

        this._panel_progress_bar = new EverpadProgressBar.EverpadProgressBar({
            box_style_class: 'everpad-progress-bar-panel-box',
            progress_style_class: 'everpad-progress-bar-panel',
            x_fill: false,
            y_fill: false,
            expand: false
        });
        this._panel_progress_bar.actor.connect('show',
            Lang.bind(this, function() {
                this._reposition_progress_bar();
            })
        );
        this._panel_progress_bar.hide();
        Main.layoutManager.panelBox.add_actor(this._panel_progress_bar.actor);

        this._syncing_in_progress = false;
        this._progress_steps = 0;
        SIGNAL_IDS.sync_state =
            DBus.get_everpad_provider_signals().connectSignal(
                'sync_state_changed',
                Lang.bind(this, function(proxy, sender, [state]) {
                    if(state != SYNC_STATES.FINISH) {
                        this._syncing_in_progress = true;
                        this._progress_steps++;

                        this._sync_status.check_status();

                        this._sync_status.progress_bar.show();
                        this._sync_status.progress_bar.set_progress(
                            this._progress_steps
                        );
                        this._sync_status.progress_bar.set_progress_label(
                            SYNC_STATES_TEXT[state]
                        );

                        this._panel_progress_bar.show();
                        this._panel_progress_bar.set_progress(
                            this._progress_steps
                        );
                    }
                    else {
                        this._syncing_in_progress = false;
                        this._progress_steps = 0;

                        this._panel_progress_bar.hide();
                        this._panel_progress_bar.reset();

                        this._sync_status.check_status();
                        this._sync_status.progress_bar.hide();
                        this._sync_status.progress_bar.reset();
                    }
                })
            );
        SIGNAL_IDS.data_changed = DBus.get_everpad_provider_signals().connectSignal(
            'data_changed',
            Lang.bind(this, function(proxy, sender) {
                if(!this._everpad.is_open) {
                    this._label.add_style_pseudo_class('updated');
                }
            })
        )

        this._add_keybindings();
    },

    _reposition_progress_bar: function() {
        let source_allocation = Shell.util_get_transformed_allocation(
            this.actor
        );
        let source_center_x = this.actor.width / 2;
        let progress_center_x = this._panel_progress_bar.actor.width / 2;
        let progress_x =
            source_allocation.x1 + source_center_x - progress_center_x;

        this._panel_progress_bar.actor.x = progress_x;
        this._panel_progress_bar.actor.y = this._button_box.height / 2;
    },

    _add_menu_items: function() {
        this._menu.add_menu_item("Create note", ICON_NAMES.create_note,
            Lang.bind(this, function() {
                DBus.get_everpad_app().createRemote();
                this._menu.hide();
                this._everpad.hide();
            })
        );
        this._menu.add_menu_item("All notes", ICON_NAMES.all_notes,
            Lang.bind(this, function() {
                DBus.get_everpad_app().all_notesRemote();
                this._menu.hide();
                this._everpad.hide();
            })
        );
        this._menu.add_menu_item("Settings", ICON_NAMES.settings,
            Lang.bind(this, function() {
                DBus.get_everpad_app().settingsRemote();
                this._menu.hide();
                this._everpad.hide();
            })
        );
        this._menu.add_menu_item("Exit", ICON_NAMES.exit,
            Lang.bind(this, function() {
                DBus.get_everpad_app().killRemote();
                this._menu.hide();
                this._everpad.hide();
            })
        );
    },

    _show_spinner: function() {
        if(this._spinner != null) return;

        this._spinner = new Animation.AnimatedIcon('process-working.svg', 24)
        this._spinner.actor.show();
        this._button_box.remove_all_children();
        this._button_box.add_actor(this._spinner.actor);
    },

    _hide_spinner: function() {
        this._spinner.actor.destroy();
        this._button_box.remove_all_children();
        this._button_box.add_actor(this._label);
    },

    _add_keybindings: function() {
        global.display.add_keybinding(
            PrefsKeys.OPEN_SNIPPETS_KEY,
            Utils.SETTINGS,
            Meta.KeyBindingFlags.NONE,
            Lang.bind(this, function() {
                this._everpad.toggle();
            })
        );
    },

    _remove_keybindings: function() {
        global.display.remove_keybinding(PrefsKeys.OPEN_SNIPPETS_KEY);
    },

    _on_button_press: function(o, e) {
        let button = e.get_button();

        if(this._button_box.timeout_id > 0) {
            Mainloop.source_remove(this._button_box.timeout_id);
        }

        switch(button) {
            case Clutter.BUTTON_SECONDARY:
                this._everpad.toggle();
                this._menu.hide();
                break;
            case Clutter.BUTTON_MIDDLE:
                DBus.get_everpad_provider().syncRemote();
                break;
            default:
                DBus.get_everpad_app().all_notesRemote();
                this._everpad.hide();
                break;
        }
    },

    _destroy_everpad_proxies: function() {
        if(DBus.EVERPAD_APP != null) {
            DBus.EVERPAD_APP.run_dispose();
            DBus.EVERPAD_APP = null;
        }
        if(DBus.EVERPAD_PROVIDER != null) {
            DBus.EVERPAD_PROVIDER.run_dispose();
            DBus.EVERPAD_PROVIDER = null;
        }
        if(DBus.EVERPAD_PROVIDER_SIGNALS != null) {
            DBus.EVERPAD_PROVIDER_SIGNALS.run_dispose();
            DBus.EVERPAD_PROVIDER_SIGNALS = null;
        }
    },

    destroy: function() {
        this._remove_keybindings();

        if(SIGNAL_IDS.sync_state > 0) {
            DBus.get_everpad_provider_signals().disconnectSignal(
                SIGNAL_IDS.sync_state
            );

            SIGNAL_IDS.sync_state = 0;
        }

        if(SIGNAL_IDS.data_changed > 0) {
            DBus.get_everpad_provider_signals().disconnectSignal(
                SIGNAL_IDS.data_changed
            );

            SIGNAL_IDS.data_changed = 0;
        }

        this._menu.destroy();
        this._everpad.destroy();
        this._sync_status.destroy();
        this._destroy_everpad_proxies();
        Utils.destroy_status_bar();
        this.parent();
    }
});

let everpad_button = null;

function init() {
    //
}

function enable() {
    check_dbus(Lang.bind(this, function(result) {
        if(result) {
            show_button();
        }
        else {
            hide_button();
        }
    }));
    SIGNAL_IDS.owner_changed = DBus.get_dbus_control().connectSignal(
        'NameOwnerChanged',
        Lang.bind(this, function(proxy, sender, [name, old_owner, new_owner]) {
            if(name == 'com.everpad.App') {
                if(old_owner && !new_owner) {
                    hide_button();
                }
                else {
                    show_button();
                }
            }
        })
    );
}

function disable() {
    if(SIGNAL_IDS.owner_changed > 0) {
        DBus.get_dbus_control().disconnectSignal(SIGNAL_IDS.owner_changed);
        SIGNAL_IDS.owner_changed = 0;
    }

    hide_button();
    DBus.destroy_dbus_proxies();
}
