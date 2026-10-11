<?xml version="1.0"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:exsl="http://exslt.org/common" xmlns:msxsl="urn:schemas-microsoft-com:xslt">
<xsl:template match="/"><xsl:variable name="v"><a/></xsl:variable><xsl:value-of select="count(exsl:node-set($v)) + count(msxsl:node-set($v))"/></xsl:template>
</xsl:stylesheet>
