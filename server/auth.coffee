crypto=require 'crypto'

#ユーザー管理の何か
user=require './rpc/user.coffee'
#params: params.userid, params.password
exports.authenticate = (params,cb) ->
    M.users.findOne {userid:params.userid}, (err,doc)->
        unless doc?
            cb {success:false}
            return
        unless check params.password, doc.password, doc.salt
            # パスワードが違う
            cb {success:false}
            return
        unless doc.salt?
            # パスワードが古いので新しいハッシュで保存
            salt = gensalt()
            ha = crpassword params.password, salt
            M.users.update {userid:params.userid}, {
                $set: {
                    password: ha,
                    salt: salt,
                },
            }, {safe:true}, (err, count)->
                if err?
                    cb {success:false}
                    return
                # 成功
                delete doc.password
                doc.success=true
                cb doc
        else
            delete doc.password
            delete doc.salt
            doc.success=true
            cb doc

# パスワードが一致するか確かめる
exports.check = check = (raw, hash, salt)->
    return false unless typeof raw == 'string' && typeof hash == 'string'
    expected = if salt? then crpassword(raw, salt) else crpassword_old(raw)
    a = Buffer.from expected
    b = Buffer.from hash
    # 長さが違う場合もタイミング差を抑えるため、ダミー比較して false
    return false unless a.length == b.length && a.length > 0
    return crypto.timingSafeEqual a, b

# saltを生成
exports.gensalt = gensalt = ()->
    return crypto.randomBytes(32).toString 'hex'
# パスワードハッシュ化
exports.crpassword = crpassword = (raw, salt)->
    return "" unless raw && salt
    sha256 = crypto.createHash "sha256"
    sha256.update "#{salt}#{raw}"
    return sha256.digest 'hex'

# 古いパスワードハッシュ
crpassword_old = (raw)->
    sha256=crypto.createHash "sha256"
    md5=crypto.createHash "md5"
    md5.update raw  # md5でハッシュ化
    sha256.update raw+md5.digest 'hex'  # sha256でさらにハッシュ化
    sha256.digest 'hex' # 结果を返す
