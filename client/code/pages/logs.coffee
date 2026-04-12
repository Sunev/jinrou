exports.start=->
    JinrouFront.loadI18n()
        .then((i18n)-> i18n.getI18nFor())
        .then (i18n)->
            # === 游标状态管理 ===
            # 维护一个游标：当前页最后一条记录的ID
            lastGameid = null
            # 历史栈：保存每一页的 lastGameid
            gameidHistory = []
            
            query = null
            
            # ルールの設定
            setjobrule = (rulearr, names, parent)->
                for obj in rulearr
                    # name,title, ruleをもつ
                    # 检查 obj.name 是否存在
                    unless obj.name?
                        console.warn "Rule object missing name:", obj
                        continue
                    
                    ruleid = names.concat obj.name
                    if Array.isArray obj.rule
                        # さらに子
                        optgroup = document.createElement "optgroup"
                        optgroup.label = i18n.t "casting:castingGroupName.#{ruleid.join '.'}._name", ruleid.join('.')
                        parent.appendChild optgroup
                        setjobrule obj.rule, ruleid, optgroup
                    else
                        # option
                        ruleidname = ruleid.join '.'
                        option=document.createElement "option"
                        option.textContent = i18n.t "casting:castingName.#{ruleidname}", ruleidname
                        option.value = ruleidname
                        option.title = i18n.t "casting:castingTitle.#{ruleidname}", ruleidname
                        parent.appendChild option
            # TODO definitions of these rules are duplicate.
            setjobrule Shared.game.jobrules.concat([
                name:"特殊规则"
                rule:[
                    {
                        name:"自由配置"
                        rule:null
                    }
                    {
                        name:"黑暗火锅"
                        rule:null
                    }
                    {
                        name:"手调黑暗火锅"
                        rule:null
                    }
                    {
                        name:"量子人狼"
                        rule:null
                    }
                    {
                        name:"Endless黑暗火锅"
                        rule:null
                    }
                ]
            ]),[],$("#rulebox").get 0
            
            # === 动态生成胜利阵营选项 ===
            populateWinnerOptions = ()->
                selectElement = $("#winnerbox").get(0)
                return unless selectElement?
                
                # 清空现有选项
                selectElement.innerHTML = ''
                
                # 定义胜利结果显示名称映射
                # 注意：数据库中 game.winner 存储的是大写的阵营ID（如 Human、LoneWolf）
                # 我们需要将这些ID映射到显示文本
                winnerNames =
                    'Human': '村人'
                    'Werewolf': '人狼'
                    'Fox': '妖狐'
                    'Devil': '恶魔'
                    'Friend': '恋人'
                    'Cult': '教会'
                    'Vampire': '吸血鬼'
                    'LoneWolf': '一匹狼'
                    'Raven': '乌鸦'
                    'Hooligan': '暴徒'
                    'Lorelei': '罗蕾莱'
                    'Draw': '平局'
                
                for winnerKey of winnerNames
                    option = document.createElement("option")
                    option.value = winnerKey
                    option.textContent = winnerNames[winnerKey]
                    selectElement.appendChild(option)
            
            # 初始化胜利阵营选项
            populateWinnerOptions()
            
            # === 更新分页按钮状态 ===
            updatePagerButtons = (rooms)->
                prevButton = $("#pager input[name='prev']").get(0)
                nextButton = $("#pager input[name='next']").get(0)
                
                if prevButton?
                    # 上一页按钮：当历史栈为空时禁用
                    if gameidHistory.length == 0
                        prevButton.disabled = true
                    else
                        prevButton.disabled = false
                
                if nextButton?
                    # 下一页按钮：当返回的房间数不足 page_number 时禁用
                    if rooms.length < 10
                        nextButton.disabled = true
                    else
                        nextButton.disabled = false
            
            # === 渲染函数 ===
            renderRooms = (rooms)->
                tbody = $("#roomlist").get(0)
                unless tbody?
                    console.error "roomlist element not found"
                    return
                
                # 清空现有内容
                tbody.innerHTML = ''
                
                # 更新分页按钮状态
                updatePagerButtons(rooms)
                
                return unless rooms? and rooms.length > 0
                
                # 渲染每一行（按照 jade 模板の表頭順序）
                for room in rooms
                    tr = document.createElement("tr")
                    
                    # 1. 房間号
                    td_id = document.createElement("td")
                    td_id.textContent = "##{room.id}" ? ''
                    tr.appendChild(td_id)
                    
                    # 2. 房間名（带リンク）
                    td_name = document.createElement("td")
                    a_name = document.createElement("a")
                    a_name.href = "/room/#{room.id}"
                    a_name.textContent = room.name ? ''
                    td_name.appendChild(a_name)
                    tr.appendChild(td_name)
                    
                    # 3. 房主
                    td_owner = document.createElement("td")
                    if room.owner?
                        a_owner = document.createElement("a")
                        a_owner.href = "/user/#{room.owner.userid}"
                        a_owner.textContent = room.owner.name ? ''
                        td_owner.appendChild(a_owner)
                    else
                        td_owner.textContent = i18n.t("rooms_client:ownerHidden")
                    tr.appendChild(td_owner)
                    
                    # 4. 人数（当前 / 最大）
                    td_players = document.createElement("td")
                    playerCount = room.players?.length ? 0
                    maxNumber = room.number ? 0
                    td_players.textContent = "#{playerCount} / #{maxNumber}"
                    tr.appendChild(td_players)
                
                    # 5. 创建时间
                    td_made = document.createElement("td")
                    if room.made?
                        madeDate = new Date(room.made)
                        td_made.textContent = madeDate.toLocaleString()
                    tr.appendChild(td_made)
                
                    # 6. 获胜阵营
                    td_winner = document.createElement("td")
                    if room.gameinfo?.winner
                        winner = room.gameinfo.winner
                        if winner is 'Draw'
                            td_winner.textContent = i18n.t('rooms_client:result.draw')
                        else
                            teamName = i18n.t("roles:teamName.#{winner}")
                            if teamName and not teamName.startsWith("roles:teamName.")
                                td_winner.textContent = "#{teamName}"
                            else
                                winnerMap =
                                    'Human': '村人'
                                    'Werewolf': '人狼'
                                    'Fox': '妖狐'
                                    'Devil': '恶魔'
                                    'Friend': '恋人'
                                    'Cult': '教会'
                                    'Vampire': '吸血鬼'
                                    'LoneWolf': '一匹狼'
                                    'Raven': '乌鸦'
                                    'Hooligan': '暴徒'
                                    'Lorelei': '罗蕾莱'
                                    'Neet': 'NEET'
                            
                                winnerName = winnerMap[winner] ? winner
                                td_winner.textContent = "#{winnerName}"
                    tr.appendChild(td_winner)
                
                    # 7. 规则
                    td_rule = document.createElement("td")
                    if room.gameinfo?.rule?.jobrule
                        td_rule.textContent = room.gameinfo.rule.jobrule
                    tr.appendChild(td_rule)
                
                    # 8. 天数
                    td_day = document.createElement("td")
                    if room.gameinfo?.day?
                        td_day.textContent = "#{room.gameinfo.day}天"
                    tr.appendChild(td_day)
                
                    tbody.appendChild(tr)
                
                # 更新游标状态：记录当前页最后一条记录のID
                if rooms.length > 0
                    lastRoom = rooms[rooms.length - 1]
                    if lastRoom?.id?
                        lastGameid = lastRoom.id

            # === RPC请求函数 ===
            # direction: 'next' 或 'prev'
            requestRooms = (direction, callback)->
                # 根据方向选择游标
                if direction == 'next'
                    # 下一页：使用当前页最后一条のID作为游标
                    cursor = if lastGameid? then "#{lastGameid}_next" else null
                else
                    # 上一页：从历史栈中取出上一页の游标
                    if gameidHistory.length > 0
                        cursor = gameidHistory[gameidHistory.length - 1]
                    else
                        cursor = null
                
                ss.rpc "game.rooms.find", query, 10, cursor, (rooms)->
                    if rooms?.error?
                        console.error "Error:", rooms.error
                        return
                    callback(rooms)
            
            # === 分页按钮イベント ===
            $("#pager").click (je)->
                return unless query?
                t=je.target
                
                if t.name == "prev"
                    # 上一页
                    if gameidHistory.length > 0
                        # 弹出当前页の游标，恢复为上一页の游标
                        gameidHistory.pop()
                        # 使用历史栈中最后一个游标（即上一页のlastGameid）
                        requestRooms('prev', renderRooms)
                    else
                        # 没有历史记录，重置到第一页
                        lastGameid = null
                        gameidHistory = []
                        renderRooms([])
                        
                else if t.name == "next"
                    # 下一页：保存当前页の游标到历史栈
                    if lastGameid?
                        gameidHistory.push "#{lastGameid}_next"
                    requestRooms('next', renderRooms)
            
            # === 表单提交イベント ===
            $("#logsform").change (je)->
                # disable/able
                t=je.target
                if result=t.name.match /^(.+)_on$/
                    t.form.elements[result[1]].disabled= !t.checked
                    
            $("#logsform").submit (je)->
                form=je.target
                je.preventDefault()
                query={}
                # 数値
                for x in ["min_number","max_number","min_day","max_day"]
                    unless form.elements[x].disabled
                        query[x]=parseInt form.elements[x].value
                for x in ["result_team","rule"]
                    unless form.elements[x].disabled
                        query[x]=form.elements[x].value

                # 重置游标状态
                lastGameid = null
                gameidHistory = []
                
                requestRooms('next', renderRooms)
        .then ()->
            $("#logsform").submit()

exports.end=->
