/// <reference path="chat.ts" />
/// <reference path="client.ts" />
/// <reference path="Identity.ts" />
/// <reference path="utils/modal.ts" />
/// <reference path="ui/modal/ModalConnect.ts" />
/// <reference path="ui/modal/ModalCreateChannel.ts" />
/// <reference path="ui/modal/ModalBanCreate.ts" />
/// <reference path="ui/modal/ModalBanClient.ts" />
/// <reference path="ui/modal/ModalYesNo.ts" />
/// <reference path="ui/modal/ModalBanList.ts" />
/// <reference path="settings.ts" />
/// <reference path="log.ts" />

let settings: Settings;
let globalClient: TSClient;
let chat: ChatBox;

let forumIdentity: TeaForumIdentity;

const js_render = window.jsrender || $;
const native_client = window.require !== undefined;

function getUserMediaFunction() {
    if(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
        return (settings, success, fail) => { navigator.mediaDevices.getUserMedia(settings).then(success).catch(fail); };
    return navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
}

function setup_close() {
    if(settings.static(Settings.KEY_DISABLE_UNLOAD_DIALOG, false)) return;

    window.onbeforeunload = event => {
        if(!globalClient.serverConnection || !globalClient.serverConnection.connected) return;

        if(!native_client) {
            event.returnValue = "Are you really sure?<br>You're still connected!";
        } else {
            event.preventDefault();
            event.returnValue = "question";

            const {remote} = require('electron');
            const dialog = remote.dialog;

            dialog.showMessageBox(remote.getCurrentWindow(), {
                    type: 'question',
                    buttons: ['Yes', 'No'],
                    title: 'Confirm',
                    message: 'Are you really sure?\nYou\'re still connected!'
            }, choice => {
                if(choice === 0) {
                    window.onbeforeunload = undefined;
                    remote.getCurrentWindow().close();
                }
            });
        }
    };
}

declare function moment(...arguments) : any;
function setup_jsrender() : boolean {
    if(!js_render) {
        displayCriticalError("Missing jsrender extension!");
        return false;
    }
    if(!js_render.views) {
        displayCriticalError("Missing jsrender viewer extension!");
        return false;
    }
    js_render.views.settings.allowCode(true);
    js_render.views.tags("rnd", (argument) => {
        let min = parseInt(argument.substr(0, argument.indexOf('~')));
        let max = parseInt(argument.substr(argument.indexOf('~') + 1));

        return (Math.round(Math.random() * (min + max + 1) - min)).toString();
    });

    js_render.views.tags("fmt_date", (...arguments) => {
        return moment(arguments[0]).format(arguments[1]);
    });

    js_render.views.tags("tr", (...arguments) => {
        return tr(arguments[0]);
    });

    $(".jsrender-template").each((idx, _entry) => {
        if(!js_render.templates(_entry.id, _entry.innerHTML)) { //, _entry.innerHTML
            console.error("Failed to cache template " + _entry.id + " for js render!");
        } else
            console.debug("Successfully loaded jsrender template " + _entry.id);
    });
    return true;
}

async function initialize() {
    const display_load_error = message => {
        if(typeof(display_critical_load) !== "undefined")
            display_critical_load(message);
        else
            displayCriticalError(message);
    };

    try {
        await i18n.initialize();
    } catch(error) {
        console.error(tr("Failed to initialized the translation system!\nError: %o"), error);
        displayCriticalError("Failed to setup the translation system");
        return;
    }

    try {
        if(!setup_jsrender())
            throw "invalid load";
    } catch (error) {
        display_load_error(tr("Failed to setup jsrender"));
        console.error(tr("Failed to load jsrender! %o"), error);
        return;
    }

    try { //Initialize main template
        const main = $("#tmpl_main").renderTag();
        $("body").append(main);
    } catch(error) {
        display_load_error(tr("Failed to setup main page!"));
        return;
    }

    AudioController.initializeAudioController();
    if(!TSIdentityHelper.setup()) {
        console.error(tr("Could not setup the TeamSpeak identity parser!"));
        return;
    }

    try {
        await ppt.initialize();
    } catch(error) {
        console.error(tr("Failed to initialize ppt!\nError: %o"), error);
        displayCriticalError(tr("Failed to initialize ppt!"));
        return;
    }
}

function main() {
    //http://localhost:63343/Web-Client/index.php?_ijt=omcpmt8b9hnjlfguh8ajgrgolr&default_connect_url=true&default_connect_type=teamspeak&default_connect_url=localhost%3A9987&disableUnloadDialog=1&loader_ignore_age=1

    settings = new Settings();
    globalClient = new TSClient();
    /** Setup the XF forum identity **/
    if(settings.static("forum_user_data")) {
        forumIdentity = new TeaForumIdentity(settings.static("forum_user_data"), settings.static("forum_user_sign"));
    }

    chat = new ChatBox($("#chat"));
    globalClient.setup();


    if(!settings.static(Settings.KEY_DISABLE_UNLOAD_DIALOG, false) && !native_client) {

    }
    //Modals.spawnConnectModal();
    //Modals.spawnSettingsModal();
    //Modals.createChannelModal(undefined);

    if(settings.static("default_connect_url")) {
        switch (settings.static("default_connect_type")) {
            case "teaforo":
                if(forumIdentity && forumIdentity.valid())
                    globalClient.startConnection(settings.static("default_connect_url"), forumIdentity);
                else
                    Modals.spawnConnectModal({
                        url: settings.static<string>("default_connect_url"),
                        enforce: true
                    }, { identity: IdentitifyType.TEAFORO, enforce: true});
                break;

            case "teamspeak":
                let connectIdentity = TSIdentityHelper.loadIdentity(settings.global("connect_identity_teamspeak_identity", ""));
                if(!connectIdentity || !connectIdentity.valid())
                    Modals.spawnConnectModal({
                        url: settings.static<string>("default_connect_url"),
                        enforce: true
                    }, { identity: IdentitifyType.TEAMSPEAK, enforce: true});
                else
                    globalClient.startConnection(settings.static("default_connect_url"), connectIdentity);
                break;

            default:
                Modals.spawnConnectModal({
                    url: settings.static<string>("default_connect_url"),
                    enforce: true
                });
        }
    }

    /*
    let tag = $("#tmpl_music_frame").renderTag({
        //thumbnail: "img/loading_image.svg"
    });



    $("#music-test").replaceWith(tag);

    Modals.spawnSettingsModal();
    /*
    Modals.spawnYesNo("Are your sure?", "Do you really want to exit?", flag => {
        console.log("Response: " + flag);
    })
    */

    setup_close();

    let _resize_timeout: NodeJS.Timer;
    $(window).on('resize', () => {
        if(_resize_timeout)
            clearTimeout(_resize_timeout);
        _resize_timeout = setTimeout(() => {
            globalClient.channelTree.handle_resized();
        }, 1000);
    });
}

app.loadedListener.push(async () => {
    try {
        await initialize();
        main();
        if(!audio.player.initialized()) {
            log.info(LogCategory.VOICE, tr("Initialize audio controller later!"));
            if(!audio.player.initializeFromGesture) {
                console.error(tr("Missing audio.player.initializeFromGesture"));
            } else
                $(document).one('click', event => audio.player.initializeFromGesture());
        }
    } catch (ex) {
        console.error(ex.stack);
        if(ex instanceof ReferenceError || ex instanceof TypeError)
            ex = ex.name + ": " + ex.message;
        displayCriticalError("Failed to invoke main function:<br>" + ex);
    }
});
