<?xml version="1.0"?>
<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:func="http://exslt.org/functions" xmlns:my="urn:my" extension-element-prefixes="func">
<xsl:use-package name="urn:pkg"/>
<func:script implements-prefix="my" language="javascript">function f(){}</func:script>
<func:function name="my:twice"><xsl:param name="n"/><func:result select="$n * 2"/></func:function>
<xsl:template match="/"><xsl:evaluate xpath="string(.)"/><xsl:source-document href="other.xml"><x/></xsl:source-document><xsl:value-of select="my:twice(2)"/></xsl:template>
</xsl:stylesheet>
