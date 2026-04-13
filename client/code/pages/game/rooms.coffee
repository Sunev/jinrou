rooms_view = null
# Cursor-based pagination state management
lastGameid = null  # gameid of the last record from previous page
gameidHistory = []  # History stack of gameids to support "previous page" navigation

exports.start=(query={})->
    mode = query.mode
    page = query.page || 0
    noLinks = !!query.noLinks
    if page < 0
        page = 0

    # Reset cursor state for new queries
    if page == 0
        lastGameid = null
        gameidHistory = []

    pi18n = JinrouFront.loadI18n()
        .then((i18n)-> i18n.getI18nFor())
    papp = JinrouFront.loadRoomList()
    prooms = requestRooms mode, page, lastGameid

    Promise.all([pi18n, papp]).then ([i18n, app])->
        rooms_view = app.place {
            i18n: i18n
            node: $("#rooms-app").get 0
            pageNumber: 10
            indexStart: page * 10 + 1
            listMode: mode ? ''
            noLinks: noLinks
            onPageMove: (dist)->
                page += dist
                if page < 0
                    page = 0
                
                # Handle cursor-based pagination
                if dist > 0
                    # Next page: save current lastGameid to history BEFORE updating it
                    # History stores the cursor needed to return to previous pages
                    if lastGameid?
                        gameidHistory.push lastGameid
                else if dist < 0
                    # Previous page: pop current page's cursor, then use the new stack top
                    # Example: 
                    #   Current page (5th): lastGameid=61, history=[101,91,81,71]
                    #   Pop 71 → history=[101,91,81]
                    #   Use 81 to query → returns page 4 (80-71)
                    if gameidHistory.length > 0
                        gameidHistory.pop()  # Remove current page's cursor
                        if gameidHistory.length > 0
                            lastGameid = gameidHistory.at(-1)  # Use previous page's cursor
                        else
                            lastGameid = null  # Back to first page
                    else
                        lastGameid = null
                
                reqRpc()
                Index.app.pushState location.pathname, {
                    page: page
                }
            getJobColor: (job)->
                jobobj = Shared.game.getjobobj job
                jobobj?.color
        }
        prooms.then (rooms)->
            rooms_view.store.setRooms rooms, page

        reqRpc = ()->
            requestRooms(mode, page, lastGameid).then((rooms)->
                rooms_view.store.setRooms rooms, page
            ).catch (err)->
                console.error "Failed to load rooms:", err
                showError(err)
                rooms_view.store.setError()

# Show user-friendly error messages
showError = (errorMessage)->
    # Create or update error message element
    errorDiv = $("#rpc-error-message")
    if errorDiv.length == 0
        errorDiv = $('<div id="rpc-error-message" style="color: red; padding: 10px; margin: 10px 0; border: 1px solid red; border-radius: 4px;"></div>')
        $("#rooms-app").prepend(errorDiv)
    
    # Translate common errors
    userMessage = switch errorMessage
        when "Request timeout"
            "查询超时，请稍后重试"
        when "common:error.invalidInput"
            "输入参数无效"
        else
            "加载失败：#{errorMessage}"
    
    errorDiv.text(userMessage)
    
    # Auto-hide after 5 seconds
    setTimeout ->
        errorDiv.fadeOut()
    , 5000

# Request rooms and return result as Promise.
pendingRoomRequest = null  # Track pending request to prevent race conditions

requestRooms = (mode, page, cursorGameid)->
    new Promise (resolve, reject)->
        # Cancel previous pending request
        if pendingRoomRequest?
            console.log "Cancelling previous room request"
            pendingRoomRequest.abort()
        
        if mode == "my"
            pendingRoomRequest = ss.rpc "game.rooms.getMyRooms", page, cursorGameid, (results)->
                pendingRoomRequest = null
                
                if results.error?
                    reject results.error
                else
                    # Update cursor: record gameid of the last entry
                    if results.length > 0
                        lastRoom = results.at(-1)
                        if lastRoom.room?
                            lastGameid = lastRoom.room.id
                    
                    resolve results.map (obj)->
                        # align with other query's object structure
                        # (with additional properties)
                        room = obj.room
                        room.gameinfo = {
                            job: obj.job
                            subtype: obj.subtype
                        }
                        return room
        else
            pendingRoomRequest = ss.rpc "game.rooms.getRooms", mode, page, (results)->
                pendingRoomRequest = null
                resolve results

exports.end = ->
  rooms_view?.unmount()
  # Clean up cursor state
  lastGameid = null
  gameidHistory = []
