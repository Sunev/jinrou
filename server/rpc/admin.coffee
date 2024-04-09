# Server-side Code
crypto=require('crypto')
child_process=require('child_process')
settings=Config.mongo

libblacklist = require '../libs/blacklist.coffee'
libi18n      = require '../libs/i18n.coffee'

i18n = libi18n.getWithDefaultNS 'admin'

# twitter系
oauth=require './../oauth.coffee'
exports.actions =(req,res,ss)->
    req.use 'session'
    # 现在のセッションを管理者として承認する
    register:(query)->
        flag=false
        req.session.administer=false
        req.session.maintenance=false
        if query.password==Config.admin.password
            req.session.administer=true
            flag=true
        if query.password==Config.maintenance.password
            req.session.maintenance=true
            flag=true

        unless flag
            res i18n.t "error.wrongPassword"
        else
            req.session.save ->res null

    # ------------- blacklist関係
    getBlacklist:(query)->
        # blacklist一覧を得る
        unless req.session.administer
            res {error: i18n.t "error.notAdmin"}
            return
        d = new Date()
        M.blacklist.find({$or:[{expires:{$gt:d}},{expires:{$exists:false}}]}).limit(100).skip(100*(query.page ? 0)).toArray (err,docs)->
            M.blacklist.count (err, count)->
                res {docs:docs,page:query.page ? 0,total:Math.ceil(docs.length / 100)}
    addBlacklist:(query)->
        # blacklistに新しいのを追加
        unless req.session.administer
            res {error: i18n.t "error.notAdmin"}
            return
        libblacklist.addBlacklist query, res
        # 即時反映（居れば）
        ss.publish.user query.userid, "forcereload"
    removeBlacklist:(query)->
        # blacklistを1つ解除
        unless req.session.administer
            res {error: i18n.t "error.notAdmin"}
            return
        libblacklist.forgive query.id, (err)->
            res err
    restoreBlacklist:(query)->
        # 解除されたblacklistをもどす
        unless req.session.administer
            res {error: i18n.t "error.notAdmin"}
            return
        libblacklist.restore query.id, (err)->
            res err
    # -------------- grandalert関係
    spreadGrandalert:(query)->
        unless req.session.administer
            res {error: i18n.t "error.notAdmin"}
            return
        if query.system
            message=
                title:query.title
                message:query.message
            ss.publish.all 'grandalert',message
        if query.twitter
            # twitterへ配信
            oauth.tweet "#{query.message} ##{Config.name}",Config.admin.password
        res null
    # -------------- dataexport関係
    dataExport:(query)->
        unless query?
            res {error: i18n.t "common:error.invalidInput"}
            return
        unless Config.admin.securityHole
            res {error: i18n.t "error.unavailable"}
            return

        sha256=crypto.createHash "sha256"
        sha256.update query.pass
        phrase=sha256.digest 'hex'
        unless phrase=='d77696ef7b89048f9e68d671da5fc825f9f2e9791fcef52c4c482d608beb49e2'
            res {error: i18n.t "error.wrongPassword"}
            return
        child = child_process.exec "mongodump -d #{settings.database} -u #{settings.user} -p #{settings.pass} -o ./public/dump", (error,stdout,stderr)->
            if error?
                res {error:stderr}
                return
            # dumpに成功した
            child_process.exec "zip -r ./public/dump/#{settings.database}.zip ./public/dump/#{settings.database}/",(error,stdout,stderr)->
                if error?
                    res {error:stdout || stderr}
                    return
                console.log stdout
                res {file:"/dump/#{settings.database}.zip"}

    # ------------- process関係
    doCommand:(query)->
        # 僕だけだよ！ あの文字列を送ろう
        unless query?
            res {error: i18n.t "common:error.invalidInput"}
            return
        unless Config.admin.securityHole
            res {error: i18n.t "error.unavailable"}
            return
        if pro?
            # まだ起動している
            pro.kill()

        sha256=crypto.createHash "sha256"
        sha256.update query.pass
        phrase=sha256.digest 'hex'
        unless phrase=='d77696ef7b89048f9e68d671da5fc825f9f2e9791fcef52c4c482d608beb49e2'
            res {error: i18n.t "error.wrongPassword"}
            return
        if query.command=="show_dbinfo"
            res result:"#{settings.database}:#{settings.user}:#{settings.pass}"
            return
        pro = child_process.exec query.command, (error,stdout,stderr)->
            pro=null
            if error?
                res {error:stderr || stdout}
                return
            res {result:stdout}
    startProcess:(cmd)->
        if pro?
            res {error: i18n.t "error.unavailable"}
            return
        unless typeof cmd=="string"
            res {error: i18n.t "common:error.invalidInput"}
            return
        args=cmd.split " "
        comm=args.shift()
        pro= child_process.spawn comm,args
    #   关闭陈旧房间
    # 关闭陈旧房间
    shutdownExpireRooms: ->
        unless req.session.maintenance
            res {error: i18n.t "error.notAdmin"}
            return
        notFresh = Date.now() - Config.rooms.fresh * 60 * 60 * 1000
        # 查询满足条件的过期房间
        M.rooms.find({"mode": {$ne: "end"}, "made": {$lt: notFresh}}).toArray (err, docs) ->
            if err?
                res {error: err}
                return
            # 遍历过期房间并更新状态
            ids = docs.map (item)-> return item.id
            # 关闭房间
            M.rooms.update({id: {$in: ids}}, {$set: {"mode": "end"}}, {multi: true}, (err) ->
                if err?
                    res {error: err}
                    return
            )
            # 更新游戏状态为已结束
            M.games.update({id: {$in: ids}}, {$set: {"finished": true}}, {multi: true}, (err) ->
                if err?
                    res {error: err}
                    return
            )
            res {result: "关闭了 #{docs.length} 个陈旧房间"}
    #-- 更新
    update:->
        unless req.session.maintenance
            res {error: i18n.t "error.notAdmin"}
            return
        script=Config.maintenance.script ? []
        result=""
        error=false
        one=(index)->
            unless script[index]?
                # もうない
                res {result:result}
                return
            result+="> #{script[index]}\n"
            child = child_process.exec script[index], (error,stdout,stderr)->
                console.log stdout
                if error?
                    result+=stderr+"\n"
                    res {error:result}
                    return
                # 成功した
                result+=stdout+"\n"
                one index+1
        one 0
    end:->
        unless req.session.maintenance
            res {error: i18n.t "error.notAdmin"}
            return
        process.exit()
        res {}

    # ------------- news関係
    # news一览を得る
    getNews:(query)->
        unless req.session.maintenance
            res {error: i18n.t "error.notAdmin"}
            return
        M.news.find().sort({time:-1}).limit(query.num).toArray (err,docs)->
            res {docs:docs}
    addNews:(query)->
        unless req.session.maintenance
            res {error: i18n.t "error.notAdmin"}
            return
        addquery=
            time:new Date()
            message:query.message
        M.news.findOne {message:addquery.message},(err,doc)->
            unless doc?
                M.news.insert addquery,{safe:true},(err,doc)->
                    res null

pro=null    # 现在のプロセス
